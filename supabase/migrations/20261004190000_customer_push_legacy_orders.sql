BEGIN;

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
  ELSIF TG_TABLE_NAME='orders' THEN
    IF NEW.status NOT IN ('completed','rejected') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    v_kind:='legacy_order'; v_record_id:=NEW.id;
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

DROP TRIGGER IF EXISTS trg_customer_push_legacy_order_update ON public.orders;
CREATE TRIGGER trg_customer_push_legacy_order_update
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.queue_customer_push_notification();

COMMIT;
