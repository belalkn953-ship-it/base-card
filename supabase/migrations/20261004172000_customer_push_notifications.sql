BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_push_subscriptions_user_idx
  ON public.customer_push_subscriptions(user_id, updated_at DESC);
ALTER TABLE public.customer_push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_push_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_push_subscriptions TO service_role;

CREATE OR REPLACE FUNCTION public.save_customer_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE v_host text; v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول'; END IF;
  IF p_endpoint IS NULL OR length(p_endpoint)>4096 OR p_endpoint !~* '^https://' THEN
    RAISE EXCEPTION 'رابط الإشعار غير صالح';
  END IF;
  v_host := lower(split_part(split_part(p_endpoint,'://',2),'/',1));
  IF v_host !~ '(^|\.)(fcm\.googleapis\.com|fcmregistrations\.googleapis\.com|web\.push\.apple\.com|push\.services\.mozilla\.com|updates\.push\.services\.mozilla\.com|notify\.windows\.com|webpush\.azure\.com)$' THEN
    RAISE EXCEPTION 'مزود الإشعار غير مدعوم';
  END IF;
  IF p_p256dh IS NULL OR p_auth IS NULL OR length(p_p256dh)<16 OR length(p_auth)<8
     OR p_p256dh !~ '^[A-Za-z0-9_-]+$' OR p_auth !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'بيانات اشتراك الإشعار غير صالحة';
  END IF;
  SELECT count(*) INTO v_count FROM public.customer_push_subscriptions
    WHERE user_id=auth.uid() AND endpoint<>p_endpoint;
  IF v_count>=10 THEN RAISE EXCEPTION 'وصلت إلى الحد الأقصى للأجهزة المفعّلة'; END IF;
  INSERT INTO public.customer_push_subscriptions(user_id,endpoint,p256dh,auth)
  VALUES(auth.uid(),p_endpoint,p_p256dh,p_auth)
  ON CONFLICT(endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,
    auth=EXCLUDED.auth,updated_at=now()
  WHERE public.customer_push_subscriptions.user_id=auth.uid();
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count=0 THEN RAISE EXCEPTION 'هذا الجهاز مرتبط بحساب آخر'; END IF;
  RETURN jsonb_build_object('enabled',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.customer_push_subscription_status(p_endpoint text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.customer_push_subscriptions
    WHERE user_id=auth.uid() AND endpoint=p_endpoint
  );
$function$;

CREATE OR REPLACE FUNCTION public.delete_customer_push_subscription(p_endpoint text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول'; END IF;
  DELETE FROM public.customer_push_subscriptions
    WHERE user_id=auth.uid() AND endpoint=p_endpoint;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count>0;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_customer_push_subscription(text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.customer_push_subscription_status(text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.delete_customer_push_subscription(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_customer_push_subscription(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_push_subscription_status(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_customer_push_subscription(text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.customer_push_event_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  record_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_type,record_id)
);
ALTER TABLE public.customer_push_event_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_push_event_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_push_event_queue TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.customer_push_event_queue_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.queue_customer_push_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,net,vault,pg_temp AS $function$
DECLARE v_kind text; v_record_id bigint; v_event_id bigint; v_secret text;
BEGIN
  IF TG_TABLE_NAME='topup_requests' THEN
    IF NEW.status NOT IN ('approved','rejected') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    v_kind:='topup'; v_record_id:=NEW.id;
  ELSIF TG_TABLE_NAME='kmcard_orders' THEN
    IF NEW.status NOT IN ('completed','rejected','refunded') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    v_kind:='kmcard_order'; v_record_id:=NEW.id;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.customer_push_event_queue(event_type,record_id)
  VALUES(v_kind,v_record_id)
  ON CONFLICT(event_type,record_id) DO NOTHING
  RETURNING id INTO v_event_id;
  IF v_event_id IS NULL THEN RETURN NEW; END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
    WHERE name='basecard_admin_push_webhook_secret' LIMIT 1;
  IF coalesce(v_secret,'')='' THEN
    UPDATE public.customer_push_event_queue SET status='failed',last_error='missing_webhook_secret' WHERE id=v_event_id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    'https://pdasckmtdpffbyooiqak.supabase.co/functions/v1/customer-push',
    jsonb_build_object('event_id',v_event_id,'event_type',v_kind,'record_id',v_record_id),
    '{}'::jsonb,
    jsonb_build_object('Content-Type','application/json','x-admin-push-secret',v_secret),
    5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF v_event_id IS NOT NULL THEN
    UPDATE public.customer_push_event_queue SET status='failed',last_error=left(sqlerrm,300) WHERE id=v_event_id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.queue_customer_push_notification() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS trg_customer_push_topup_update ON public.topup_requests;
CREATE TRIGGER trg_customer_push_topup_update
AFTER UPDATE OF status ON public.topup_requests
FOR EACH ROW EXECUTE FUNCTION public.queue_customer_push_notification();

DROP TRIGGER IF EXISTS trg_customer_push_kmcard_order_update ON public.kmcard_orders;
CREATE TRIGGER trg_customer_push_kmcard_order_update
AFTER UPDATE OF status ON public.kmcard_orders
FOR EACH ROW EXECUTE FUNCTION public.queue_customer_push_notification();

COMMIT;
