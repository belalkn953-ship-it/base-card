BEGIN;

ALTER TABLE public.km_price_anchors
  DROP CONSTRAINT IF EXISTS km_price_anchors_product_kind_check;
ALTER TABLE public.km_price_anchors
  ADD CONSTRAINT km_price_anchors_product_kind_check
  CHECK (product_kind IN ('game','chat','transfer'));

-- Admin edits set the current sale price and reset the private provider-cost
-- anchor in one transaction. Existing denominations are checked in the Edge Function.
CREATE OR REPLACE FUNCTION public.service_set_km_price_anchor(
  p_product_kind text,
  p_product_id bigint,
  p_quantity numeric,
  p_base_sale_price_syp numeric,
  p_provider_cost_syp numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_raw text;
  v_prices jsonb;
  v_sale_key text;
  v_quantity_text text;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_product_kind NOT IN ('game','chat','transfer') OR p_product_id IS NULL OR p_product_id <= 0
     OR p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 1000000000000
     OR p_base_sale_price_syp IS NULL OR p_base_sale_price_syp <= 0 OR p_base_sale_price_syp > 1000000000000
     OR p_provider_cost_syp IS NULL OR p_provider_cost_syp <= 0 OR p_provider_cost_syp > 1000000000000 THEN
    RAISE EXCEPTION 'invalid price anchor';
  END IF;
  IF p_product_kind = 'chat' AND p_quantity <> 1 THEN
    RAISE EXCEPTION 'chat price anchor must be per unit';
  END IF;
  IF p_product_kind = 'transfer' AND p_product_id NOT IN (4,11) THEN
    RAISE EXCEPTION 'invalid transfer product';
  END IF;

  IF p_product_kind IN ('game','transfer') THEN
    v_quantity_text := regexp_replace(regexp_replace(to_char(p_quantity, 'FM999999999999.999999'), '0+$', ''), '\.$', '');
    v_sale_key := p_product_id::text || ':' || v_quantity_text;
    PERFORM pg_advisory_xact_lock(hashtextextended('km_sale_prices', 820443));
    SELECT s.value INTO v_raw FROM public.settings AS s WHERE s.key = 'km_sale_prices' FOR UPDATE;
    BEGIN
      v_prices := coalesce(nullif(v_raw,''),'{}')::jsonb;
      IF jsonb_typeof(v_prices) <> 'object' THEN RAISE EXCEPTION 'invalid sale-price settings'; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'تعذر قراءة أسعار البيع الحالية؛ لم يتم تغيير السعر';
    END;
    v_prices := jsonb_set(v_prices, ARRAY[v_sale_key], to_jsonb(p_base_sale_price_syp), true);
    INSERT INTO public.settings(key,value) VALUES ('km_sale_prices',v_prices::text)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
  END IF;

  INSERT INTO public.km_price_anchors(product_kind,product_id,sale_quantity,base_sale_price_syp,provider_cost_syp,updated_at)
  VALUES (p_product_kind,p_product_id,p_quantity,p_base_sale_price_syp,p_provider_cost_syp,now())
  ON CONFLICT (product_kind,product_id,sale_quantity) DO UPDATE
    SET base_sale_price_syp=EXCLUDED.base_sale_price_syp,
        provider_cost_syp=EXCLUDED.provider_cost_syp,
        updated_at=now();
  RETURN jsonb_build_object('saved',true,'product_kind',p_product_kind,'product_id',p_product_id,'quantity',p_quantity);
END;
$function$;
REVOKE ALL ON FUNCTION public.service_set_km_price_anchor(text,bigint,numeric,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_set_km_price_anchor(text,bigint,numeric,numeric,numeric) TO service_role;

-- Synchronize only transfer quantities already present in the customer's sale map.
-- On first run the anchor is seeded from the current sale and supplier price, so
-- customers' existing prices and margins do not move. Later, the sale change is
-- (new supplier unit cost - old supplier unit cost) * the unchanged quantity.
CREATE OR REPLACE FUNCTION public.service_sync_km_transfer_prices(p_items jsonb)
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
  v_quantity_text text;
  v_sale_key text;
  v_changed_count integer := 0;
  v_touched boolean := false;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'invalid transfer price batch';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('km_sale_prices', 820443));
  SELECT s.value INTO v_raw FROM public.settings AS s WHERE s.key='km_sale_prices' FOR UPDATE;
  BEGIN
    v_prices := coalesce(nullif(v_raw,''),'{}')::jsonb;
    IF jsonb_typeof(v_prices) <> 'object' THEN RAISE EXCEPTION 'invalid sale-price settings'; END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'تعذر قراءة أسعار التحويل؛ لم يتم تغيير أي سعر';
  END;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_product_id := (v_item->>'product_id')::bigint;
      v_quantity := (v_item->>'quantity')::numeric;
      v_current_cost := (v_item->>'provider_cost_syp')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid transfer price item';
    END;
    IF v_product_id NOT IN (4,11) OR v_quantity IS NULL OR v_quantity <= 0 OR v_quantity > 1000000000000
       OR v_current_cost IS NULL OR v_current_cost <= 0 OR v_current_cost > 1000000000000 THEN
      RAISE EXCEPTION 'invalid transfer price item';
    END IF;

    v_quantity_text := regexp_replace(regexp_replace(to_char(v_quantity, 'FM999999999999.999999'), '0+$', ''), '\.$', '');
    v_sale_key := v_product_id::text || ':' || v_quantity_text;
    IF NOT (v_prices ? v_sale_key) THEN
      CONTINUE;
    END IF;
    BEGIN
      v_current_sale := (v_prices->>v_sale_key)::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid saved transfer sale price';
    END;
    IF v_current_sale IS NULL OR v_current_sale <= 0 OR v_current_sale > 1000000000000 THEN
      RAISE EXCEPTION 'invalid saved transfer sale price';
    END IF;

    SELECT a.provider_cost_syp INTO v_previous_cost
      FROM public.km_price_anchors AS a
     WHERE a.product_kind='transfer' AND a.product_id=v_product_id AND a.sale_quantity=v_quantity
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.km_price_anchors(product_kind,product_id,sale_quantity,base_sale_price_syp,provider_cost_syp,updated_at)
      VALUES ('transfer',v_product_id,v_quantity,v_current_sale,v_current_cost,now())
      ON CONFLICT (product_kind,product_id,sale_quantity) DO NOTHING;
      v_touched := true;
      CONTINUE;
    END IF;

    IF v_previous_cost IS DISTINCT FROM v_current_cost THEN
      v_adjusted_sale := round(v_current_sale + ((v_current_cost-v_previous_cost)*v_quantity),2);
      IF v_adjusted_sale <= 0 OR v_adjusted_sale > 1000000000000 THEN
        RAISE EXCEPTION 'transfer sale price adjustment is out of range';
      END IF;
      v_prices := jsonb_set(v_prices, ARRAY[v_sale_key], to_jsonb(v_adjusted_sale), true);
      v_changed_count := v_changed_count + 1;
      v_touched := true;
    ELSE
      v_adjusted_sale := v_current_sale;
    END IF;

    UPDATE public.km_price_anchors AS a
       SET base_sale_price_syp=v_adjusted_sale,
           provider_cost_syp=v_current_cost,
           updated_at=now()
     WHERE a.product_kind='transfer' AND a.product_id=v_product_id AND a.sale_quantity=v_quantity;
  END LOOP;

  IF v_touched THEN
    INSERT INTO public.settings(key,value) VALUES ('km_sale_prices',v_prices::text)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
  END IF;
  RETURN jsonb_build_object('ok',true,'changed_prices',v_changed_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.service_sync_km_transfer_prices(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_sync_km_transfer_prices(jsonb) TO service_role;

COMMIT;
