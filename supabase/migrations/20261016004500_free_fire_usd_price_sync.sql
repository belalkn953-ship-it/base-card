BEGIN;

-- Store independent USD sale-price anchors for approved Free Fire products.
-- Supplier costs and anchors remain service-role-only.
CREATE TABLE IF NOT EXISTS public.km_usd_price_anchors (
  product_kind text NOT NULL DEFAULT 'game' CHECK (product_kind = 'game'),
  product_id bigint NOT NULL CHECK (product_id IN (276,277,14,20,23,27,31,426,431,436,437,1104)),
  sale_quantity numeric NOT NULL DEFAULT 1 CHECK (sale_quantity = 1),
  base_sale_price_usd numeric NOT NULL CHECK (base_sale_price_usd > 0 AND base_sale_price_usd <= 1000000000000),
  provider_cost_usd numeric NOT NULL CHECK (provider_cost_usd > 0 AND provider_cost_usd <= 1000000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_kind, product_id, sale_quantity)
);
ALTER TABLE public.km_usd_price_anchors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.km_usd_price_anchors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.km_usd_price_anchors TO service_role;

CREATE OR REPLACE FUNCTION public.service_set_km_usd_price_anchor(
  p_product_id bigint,
  p_base_sale_price_usd numeric,
  p_provider_cost_usd numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_raw text;
  v_prices jsonb;
  v_sale_key text;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_product_id NOT IN (276,277,14,20,23,27,31,426,431,436,437,1104)
     OR p_base_sale_price_usd IS NULL OR p_base_sale_price_usd <= 0 OR p_base_sale_price_usd > 1000000000000
     OR p_provider_cost_usd IS NULL OR p_provider_cost_usd <= 0 OR p_provider_cost_usd > 1000000000000 THEN
    RAISE EXCEPTION 'invalid Free Fire USD price';
  END IF;

  v_sale_key := p_product_id::text || ':1';
  PERFORM pg_advisory_xact_lock(hashtextextended('km_sale_prices_usd', 820444));
  SELECT s.value INTO v_raw FROM public.settings AS s WHERE s.key = 'km_sale_prices_usd' FOR UPDATE;
  BEGIN
    v_prices := coalesce(nullif(v_raw,''),'{}')::jsonb;
    IF jsonb_typeof(v_prices) <> 'object' THEN RAISE EXCEPTION 'invalid USD sale-price settings'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'تعذر قراءة أسعار الدولار؛ لم يتم تغيير السعر';
  END;
  v_prices := jsonb_set(v_prices, ARRAY[v_sale_key], to_jsonb(p_base_sale_price_usd), true);
  INSERT INTO public.settings(key,value) VALUES ('km_sale_prices_usd',v_prices::text)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;

  INSERT INTO public.km_usd_price_anchors(product_kind,product_id,sale_quantity,base_sale_price_usd,provider_cost_usd,updated_at)
  VALUES ('game',p_product_id,1,p_base_sale_price_usd,p_provider_cost_usd,now())
  ON CONFLICT (product_kind,product_id,sale_quantity) DO UPDATE
    SET base_sale_price_usd=EXCLUDED.base_sale_price_usd,
        provider_cost_usd=EXCLUDED.provider_cost_usd,
        updated_at=now();
  RETURN jsonb_build_object('saved',true,'product_id',p_product_id,'quantity',1);
END;
$function$;
REVOKE ALL ON FUNCTION public.service_set_km_usd_price_anchor(bigint,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_set_km_usd_price_anchor(bigint,numeric,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.service_sync_km_usd_game_prices(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_raw text;
  v_prices jsonb;
  v_item jsonb;
  v_product_id bigint;
  v_quantity numeric;
  v_current_cost numeric;
  v_previous_cost numeric;
  v_current_sale numeric;
  v_adjusted_sale numeric;
  v_sale_key text;
  v_changed_count integer := 0;
  v_touched boolean := false;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'invalid USD price batch';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('km_sale_prices_usd', 820444));
  SELECT s.value INTO v_raw FROM public.settings AS s WHERE s.key='km_sale_prices_usd' FOR UPDATE;
  BEGIN
    v_prices := coalesce(nullif(v_raw,''),'{}')::jsonb;
    IF jsonb_typeof(v_prices) <> 'object' THEN RAISE EXCEPTION 'invalid USD sale-price settings'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'تعذر قراءة أسعار الدولار؛ لم يتغير أي سعر';
  END;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_product_id := (v_item->>'product_id')::bigint;
      v_quantity := (v_item->>'quantity')::numeric;
      v_current_cost := (v_item->>'provider_cost_usd')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid USD price item';
    END;
    IF v_product_id NOT IN (276,277,14,20,23,27,31,426,431,436,437,1104)
       OR v_quantity IS DISTINCT FROM 1
       OR v_current_cost IS NULL OR v_current_cost <= 0 OR v_current_cost > 1000000000000 THEN
      RAISE EXCEPTION 'invalid USD price item';
    END IF;

    v_sale_key := v_product_id::text || ':1';
    IF NOT (v_prices ? v_sale_key) THEN CONTINUE; END IF;
    BEGIN
      v_current_sale := (v_prices->>v_sale_key)::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid saved USD sale price';
    END;
    IF v_current_sale IS NULL OR v_current_sale <= 0 OR v_current_sale > 1000000000000 THEN
      RAISE EXCEPTION 'invalid saved USD sale price';
    END IF;

    SELECT a.provider_cost_usd INTO v_previous_cost
      FROM public.km_usd_price_anchors AS a
     WHERE a.product_kind='game' AND a.product_id=v_product_id AND a.sale_quantity=1
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.km_usd_price_anchors(product_kind,product_id,sale_quantity,base_sale_price_usd,provider_cost_usd,updated_at)
      VALUES ('game',v_product_id,1,v_current_sale,v_current_cost,now())
      ON CONFLICT (product_kind,product_id,sale_quantity) DO NOTHING;
      v_touched := true;
      CONTINUE;
    END IF;

    IF v_previous_cost IS DISTINCT FROM v_current_cost THEN
      v_adjusted_sale := round(v_current_sale + ((v_current_cost-v_previous_cost)*v_quantity),2);
      IF v_adjusted_sale <= 0 OR v_adjusted_sale > 1000000000000 THEN
        RAISE EXCEPTION 'USD sale price adjustment is out of range';
      END IF;
      v_prices := jsonb_set(v_prices, ARRAY[v_sale_key], to_jsonb(v_adjusted_sale), true);
      v_changed_count := v_changed_count + 1;
      v_touched := true;
    ELSE
      v_adjusted_sale := v_current_sale;
    END IF;

    UPDATE public.km_usd_price_anchors AS a
       SET base_sale_price_usd=v_adjusted_sale,
           provider_cost_usd=v_current_cost,
           updated_at=now()
     WHERE a.product_kind='game' AND a.product_id=v_product_id AND a.sale_quantity=1;
  END LOOP;

  IF v_touched THEN
    INSERT INTO public.settings(key,value) VALUES ('km_sale_prices_usd',v_prices::text)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
  END IF;
  RETURN jsonb_build_object('ok',true,'changed_prices',v_changed_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.service_sync_km_usd_game_prices(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_sync_km_usd_game_prices(jsonb) TO service_role;

COMMIT;
