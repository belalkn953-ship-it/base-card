BEGIN;

CREATE OR REPLACE FUNCTION public.customer_order_target_id(p_params jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $function$
  SELECT q.safe_value
  FROM (
    SELECT
      pg_catalog.lower(pg_catalog.regexp_replace(e.key, '[[:space:]_:-]+', '', 'g')) AS normalized_key,
      NULLIF(
        pg_catalog.left(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(CASE WHEN pg_catalog.jsonb_typeof(e.value)='string' THEN e.value #>> '{}' ELSE e.value::text END),
            '[[:cntrl:]]', '', 'g'
          ),
          80
        ),
        ''
      ) AS safe_value
    FROM pg_catalog.jsonb_each(
      CASE WHEN pg_catalog.jsonb_typeof(p_params)='object' THEN p_params ELSE '{}'::jsonb END
    ) AS e(key,value)
    WHERE pg_catalog.jsonb_typeof(e.value) IN ('string','number')
  ) AS q
  WHERE q.normalized_key IN (
    'userid','useridhere','playerid','playeridhere','uid','gameid',
    'ايدياللاعب','أيدياللاعب','ايديالمستخدم','أيديالمستخدم',
    'ايديالمسنخدم','ايديالمستحدم','معرفالمستخدم','معرّفالمستخدم',
    'معرفاللاعب','معرّفاللاعب'
  )
    AND q.safe_value IS NOT NULL
  ORDER BY CASE q.normalized_key
    WHEN 'userid' THEN 1 WHEN 'playerid' THEN 2 WHEN 'uid' THEN 3 WHEN 'gameid' THEN 4 ELSE 5 END
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.customer_order_target_id(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.my_recent_orders_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_orders jsonb;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'سجّل الدخول أولًا لعرض الطلبات'; END IF;
  SELECT COALESCE(jsonb_agg(q.payload ORDER BY q.created_at DESC), '[]'::jsonb)
    INTO v_orders
  FROM (
    SELECT k.created_at,
      jsonb_build_object(
        'order_number',k.order_number,'status',k.status,'provider_status',k.provider_status,
        'category_name',k.category_name,'product_name',k.product_name,'charged_syp',k.charged_syp,
        'created_at',k.created_at,'updated_at',k.updated_at,'source','kmcard',
        'title',COALESCE(NULLIF(k.category_name,''),'خدمة الشحن'),
        'package_name',COALESCE(k.product_name,'—'),'amount',k.charged_syp,'currency','SYP',
        'target_id',CASE WHEN k.product_id IN (4,11) OR lower(COALESCE(k.category_name,'')) IN ('syriatel','mtn','ام تي ان') THEN NULL
          ELSE public.customer_order_target_id(k.params) END
      ) AS payload
    FROM public.kmcard_orders k
    WHERE k.user_id=v_user_id AND k.created_at>=now()-interval '24 hours' AND k.created_at<=now()
    UNION ALL
    SELECT o.created_at,
      jsonb_build_object(
        'order_number',o.order_number,'status',o.status,'created_at',o.created_at,'updated_at',o.updated_at,
        'source','legacy','title','طلب شحن','package_name',COALESCE(p.name,'—'),
        'amount',COALESCE(p.price_amount,CASE WHEN btrim(COALESCE(p.price,'')) ~ '^[0-9]+([.][0-9]+)?$' THEN btrim(p.price)::numeric ELSE 0 END),
        'currency',COALESCE(p.currency,'SYP'),'target_id',NULLIF(btrim(o.player_id),'')
      ) AS payload
    FROM public.orders o
    LEFT JOIN public.packages p ON p.id=o.package_id
    WHERE o.user_id=v_user_id AND o.created_at>=now()-interval '24 hours' AND o.created_at<=now()
  ) q;
  RETURN COALESCE(v_orders,'[]'::jsonb);
END;
$function$;

COMMIT;
