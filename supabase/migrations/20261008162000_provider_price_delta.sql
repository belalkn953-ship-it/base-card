BEGIN;

-- Private supplier-price anchors. Public settings only keep customer sale prices;
-- provider costs remain service-role-only.
CREATE TABLE IF NOT EXISTS public.km_price_anchors (
  product_kind text NOT NULL CHECK (product_kind IN ('game','chat')),
  product_id bigint NOT NULL CHECK (product_id > 0),
  sale_quantity numeric NOT NULL CHECK (sale_quantity > 0),
  base_sale_price_syp numeric NOT NULL CHECK (base_sale_price_syp > 0),
  provider_cost_syp numeric NOT NULL CHECK (provider_cost_syp > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_kind, product_id, sale_quantity)
);
ALTER TABLE public.km_price_anchors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.km_price_anchors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.km_price_anchors TO service_role;

-- The Edge Function uses this service-only RPC after validating an admin and
-- fetching the current supplier price. For games it atomically saves the base
-- price in the existing public sale-price map and resets the private anchor.
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
  raw text;
  prices jsonb;
  sale_key text;
  quantity_text text;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_product_kind NOT IN ('game','chat') OR p_product_id IS NULL OR p_product_id <= 0
     OR p_quantity IS NULL OR p_quantity <= 0
     OR p_base_sale_price_syp IS NULL OR p_base_sale_price_syp <= 0
     OR p_provider_cost_syp IS NULL OR p_provider_cost_syp <= 0 THEN
    RAISE EXCEPTION 'invalid price anchor';
  END IF;
  IF p_product_kind = 'chat' AND p_quantity <> 1 THEN
    RAISE EXCEPTION 'chat price anchor must be per unit';
  END IF;

  IF p_product_kind = 'game' THEN
    quantity_text := regexp_replace(regexp_replace(to_char(p_quantity, 'FM999999999.999999'), '0+$', ''), '\.$', '');
    sale_key := p_product_id::text || ':' || quantity_text;
    PERFORM pg_advisory_xact_lock(hashtextextended('km_sale_prices', 820443));
    SELECT value INTO raw FROM public.settings WHERE key = 'km_sale_prices' FOR UPDATE;
    BEGIN
      prices := coalesce(nullif(raw,''),'{}')::jsonb;
      IF jsonb_typeof(prices) <> 'object' THEN RAISE EXCEPTION 'invalid sale-price settings'; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'تعذر قراءة أسعار البيع الحالية؛ لم يتم تغيير السعر';
    END;
    prices := jsonb_set(prices, ARRAY[sale_key], to_jsonb(p_base_sale_price_syp), true);
    INSERT INTO public.settings(key,value) VALUES ('km_sale_prices',prices::text)
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

CREATE OR REPLACE FUNCTION public.create_kmcard_order_internal(
  p_user_id uuid,
  p_product_id bigint,
  p_product_name text,
  p_category_name text,
  p_quantity numeric,
  p_price_usd numeric,
  p_params jsonb,
  p_order_uuid uuid DEFAULT NULL,
  p_sale_price_syp numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  uid uuid := p_user_id;
  w public.wallets;
  charge numeric;
  new_balance numeric;
  oid bigint;
  order_no text;
  ouuid uuid := coalesce(p_order_uuid, gen_random_uuid());
  txid bigint;
  existing public.kmcard_orders;
  raw text;
  prices jsonb;
  expected numeric;
  baseline_cost numeric;
  sale_key text := p_product_id::text || ':' || regexp_replace(regexp_replace(to_char(p_quantity, 'FM999999999.999999'), '0+$', ''), '\.$', '');
BEGIN
  IF coalesce(auth.jwt()->>'role', '') <> 'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  IF uid IS NULL OR p_product_id IS NULL OR p_product_id <= 0 THEN RAISE EXCEPTION 'بيانات المنتج غير صالحة'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 1000000000 THEN RAISE EXCEPTION 'الكمية غير صالحة'; END IF;
  IF p_price_usd IS NULL OR p_price_usd <= 0 OR p_price_usd > 1000000000000 THEN RAISE EXCEPTION 'تكلفة المزوّد غير صالحة'; END IF;
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN RAISE EXCEPTION 'بيانات الطلب غير صالحة'; END IF;

  SELECT * INTO existing FROM public.kmcard_orders WHERE order_uuid=ouuid AND user_id=uid;
  IF FOUND THEN
    IF existing.product_id <> p_product_id OR existing.quantity <> p_quantity THEN RAISE EXCEPTION 'مفتاح الطلب مستخدم لمنتج أو كمية مختلفة'; END IF;
    RETURN jsonb_build_object('id',existing.id,'order_number',existing.order_number,'order_uuid',existing.order_uuid,'charged_syp',existing.charged_syp,'status',existing.status,'provider_status',existing.provider_status,'provider_order_id',existing.provider_order_id,'already_exists',true);
  END IF;

  SELECT value INTO raw FROM public.settings WHERE key='km_sale_prices';
  BEGIN prices := coalesce(nullif(raw,''),'{}')::jsonb; EXCEPTION WHEN OTHERS THEN prices := '{}'::jsonb; END;
  expected := (prices->>sale_key)::numeric;
  IF expected IS NULL OR expected <= 0 OR expected > 1000000000000 THEN RAISE EXCEPTION 'سعر البيع غير مضبوط لهذه الباقة؛ لم يتم الخصم'; END IF;

  -- MTN/Syriatel products are intentionally excluded; their saved prices never move here.
  IF p_product_id NOT IN (4,11) THEN
    SELECT provider_cost_syp INTO baseline_cost
      FROM public.km_price_anchors
     WHERE product_kind='game' AND product_id=p_product_id AND sale_quantity=p_quantity;
    IF FOUND THEN expected := expected + ((p_price_usd-baseline_cost)*p_quantity); END IF;
  END IF;
  expected := round(expected,2);
  IF expected <= 0 OR expected > 1000000000000 THEN RAISE EXCEPTION 'سعر البيع المعدّل غير صالح؛ لم يتم الخصم'; END IF;
  IF p_sale_price_syp IS NOT NULL AND round(p_sale_price_syp,2) <> expected THEN RAISE EXCEPTION 'سعر الباقة تغيّر؛ حدّث الصفحة قبل الشراء'; END IF;

  charge := expected;
  INSERT INTO public.wallets(user_id) VALUES (uid) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.wallets WHERE user_id=uid FOR UPDATE;
  IF w.balance_syp < charge THEN RAISE EXCEPTION 'الرصيد غير كافٍ، اشحن محفظتك أولًا'; END IF;
  new_balance := w.balance_syp-charge;
  UPDATE public.wallets SET balance_syp=new_balance,updated_at=now() WHERE user_id=uid;
  order_no := 'KM-' || to_char(now(),'YYYYMMDD') || '-' || lpad((floor(random()*900000)+100000)::text,6,'0');
  INSERT INTO public.kmcard_orders(order_number,user_id,product_id,product_name,category_name,quantity,params,price_usd,charged_syp,order_uuid)
  VALUES(order_no,uid,p_product_id,coalesce(p_product_name,''),coalesce(p_category_name,''),p_quantity,p_params,p_price_usd,charge,ouuid) RETURNING id INTO oid;
  INSERT INTO public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
  VALUES(uid,'purchase',-charge,'SYP',new_balance,'kmcard_order',oid,'شراء باقة من المحفظة') RETURNING id INTO txid;
  RETURN jsonb_build_object('id',oid,'order_number',order_no,'order_uuid',ouuid,'charged_syp',charge,'balance_after',new_balance);
END;
$function$;
REVOKE ALL ON FUNCTION public.create_kmcard_order_internal(uuid,bigint,text,text,numeric,numeric,jsonb,uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_kmcard_order_internal(uuid,bigint,text,text,numeric,numeric,jsonb,uuid,numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.create_kmcard_chat_order(
  p_user_id uuid,
  p_product_id bigint,
  p_product_name text,
  p_category_name text,
  p_quantity numeric,
  p_provider_unit_cost_syp numeric,
  p_params jsonb,
  p_order_uuid uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  w public.wallets;
  charge numeric;
  new_balance numeric;
  oid bigint;
  order_no text;
  ouuid uuid := coalesce(p_order_uuid, gen_random_uuid());
  existing public.kmcard_orders;
  txid bigint;
  base_sale numeric;
  baseline_cost numeric;
  unit_sale numeric;
BEGIN
  IF coalesce(auth.jwt()->>'role','') <> 'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  IF p_user_id IS NULL OR p_product_id IS NULL OR p_product_id <= 0 THEN RAISE EXCEPTION 'بيانات المنتج غير صالحة'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_provider_unit_cost_syp IS NULL OR p_provider_unit_cost_syp <= 0 THEN RAISE EXCEPTION 'بيانات الكمية أو السعر غير صالحة'; END IF;
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN RAISE EXCEPTION 'بيانات الطلب غير صالحة'; END IF;

  SELECT * INTO existing FROM public.kmcard_orders WHERE order_uuid=ouuid AND user_id=p_user_id;
  IF FOUND THEN
    RETURN jsonb_build_object('id',existing.id,'order_number',existing.order_number,'order_uuid',existing.order_uuid,'charged_syp',existing.charged_syp,'status',existing.status,'provider_status',existing.provider_status,'provider_order_id',existing.provider_order_id,'already_exists',true);
  END IF;

  SELECT base_sale_price_syp,provider_cost_syp INTO base_sale,baseline_cost
    FROM public.km_price_anchors WHERE product_kind='chat' AND product_id=p_product_id AND sale_quantity=1;
  IF FOUND THEN unit_sale := base_sale + (p_provider_unit_cost_syp-baseline_cost);
  ELSE unit_sale := p_provider_unit_cost_syp*1.14; END IF;
  IF unit_sale <= 0 THEN RAISE EXCEPTION 'سعر البيع المعدّل غير صالح'; END IF;
  charge := ceil(unit_sale*p_quantity);

  INSERT INTO public.wallets(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.wallets WHERE user_id=p_user_id FOR UPDATE;
  IF w.balance_syp < charge THEN RAISE EXCEPTION 'الرصيد غير كافٍ، اشحن محفظتك أولًا'; END IF;
  new_balance := w.balance_syp-charge;
  UPDATE public.wallets SET balance_syp=new_balance,updated_at=now() WHERE user_id=p_user_id;
  order_no := 'KM-' || to_char(now(),'YYYYMMDD') || '-' || lpad((floor(random()*900000)+100000)::text,6,'0');
  INSERT INTO public.kmcard_orders(order_number,user_id,product_id,product_name,category_name,quantity,params,price_usd,charged_syp,order_uuid)
  VALUES(order_no,p_user_id,p_product_id,coalesce(p_product_name,''),coalesce(p_category_name,''),p_quantity,p_params,p_provider_unit_cost_syp,charge,ouuid) RETURNING id INTO oid;
  INSERT INTO public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
  VALUES(p_user_id,'purchase',-charge,'SYP',new_balance,'kmcard_order',oid,'شراء باقة تطبيق من المحفظة') RETURNING id INTO txid;
  RETURN jsonb_build_object('id',oid,'order_number',order_no,'order_uuid',ouuid,'charged_syp',charge,'balance_after',new_balance);
END;
$function$;
REVOKE ALL ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) TO service_role;

COMMIT;
