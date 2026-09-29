CREATE OR REPLACE FUNCTION public.my_recent_orders_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_orders jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'سجّل الدخول أولًا لعرض الطلبات';
  END IF;

  SELECT COALESCE(jsonb_agg(q.payload ORDER BY q.created_at DESC), '[]'::jsonb)
    INTO v_orders
  FROM (
    SELECT k.created_at,
      jsonb_build_object(
        'order_number', k.order_number,
        'status', k.status,
        'provider_status', k.provider_status,
        'category_name', k.category_name,
        'product_name', k.product_name,
        'charged_syp', k.charged_syp,
        'created_at', k.created_at,
        'updated_at', k.updated_at,
        'source', 'kmcard',
        'title', COALESCE(NULLIF(k.category_name, ''), 'خدمة الشحن'),
        'package_name', COALESCE(k.product_name, '—'),
        'amount', k.charged_syp,
        'currency', 'SYP'
      ) AS payload
    FROM public.kmcard_orders k
    WHERE k.user_id = v_user_id
      AND k.created_at >= now() - interval '24 hours'
      AND k.created_at <= now()

    UNION ALL

    SELECT o.created_at,
      jsonb_build_object(
        'order_number', o.order_number,
        'status', o.status,
        'created_at', o.created_at,
        'updated_at', o.updated_at,
        'source', 'legacy',
        'title', 'طلب شحن',
        'package_name', COALESCE(p.name, '—'),
        'amount', COALESCE(
          p.price_amount,
          CASE WHEN btrim(COALESCE(p.price, '')) ~ '^[0-9]+([.][0-9]+)?$'
            THEN btrim(p.price)::numeric ELSE 0 END
        ),
        'currency', COALESCE(p.currency, 'SYP')
      ) AS payload
    FROM public.orders o
    LEFT JOIN public.packages p ON p.id = o.package_id
    WHERE o.user_id = v_user_id
      AND o.created_at >= now() - interval '24 hours'
      AND o.created_at <= now()
  ) q;

  RETURN COALESCE(v_orders, '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.my_recent_orders_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_recent_orders_v1() TO authenticated;
