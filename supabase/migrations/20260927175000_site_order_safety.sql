-- Preserve all existing catalog entries and quantities. This migration only repairs order safety.

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
declare
  w public.wallets;
  charge numeric;
  new_balance numeric;
  oid bigint;
  order_no text;
  ouuid uuid := coalesce(p_order_uuid, gen_random_uuid());
  existing public.kmcard_orders;
  txid bigint;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_user_id is null or p_product_id is null or p_product_id <= 0 then
    raise exception 'بيانات المنتج غير صالحة';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_provider_unit_cost_syp is null or p_provider_unit_cost_syp <= 0 then
    raise exception 'بيانات الكمية أو السعر غير صالحة';
  end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' then
    raise exception 'بيانات الطلب غير صالحة';
  end if;

  select * into existing from public.kmcard_orders
   where order_uuid = ouuid and user_id = p_user_id;
  if found then
    return jsonb_build_object(
      'id', existing.id, 'order_number', existing.order_number,
      'order_uuid', existing.order_uuid, 'charged_syp', existing.charged_syp,
      'status', existing.status, 'provider_status', existing.provider_status,
      'provider_order_id', existing.provider_order_id, 'already_exists', true
    );
  end if;

  -- Chat-app selling price follows the previously approved 14% margin.
  charge := ceil(p_provider_unit_cost_syp * p_quantity * 1.14);
  if charge <= 0 then raise exception 'سعر البيع غير صالح'; end if;

  insert into public.wallets(user_id) values(p_user_id) on conflict do nothing;
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.balance_syp < charge then raise exception 'الرصيد غير كافٍ، اشحن محفظتك أولًا'; end if;
  new_balance := w.balance_syp - charge;
  update public.wallets set balance_syp = new_balance, updated_at = now() where user_id = p_user_id;

  order_no := 'KM-' || to_char(now(),'YYYYMMDD') || '-' || lpad((floor(random()*900000)+100000)::text,6,'0');
  insert into public.kmcard_orders(
    order_number,user_id,product_id,product_name,category_name,quantity,params,
    price_usd,charged_syp,order_uuid
  ) values (
    order_no,p_user_id,p_product_id,coalesce(p_product_name,''),coalesce(p_category_name,''),
    p_quantity,p_params,p_provider_unit_cost_syp,charge,ouuid
  ) returning id into oid;

  insert into public.wallet_transactions(
    user_id,type,amount,currency,balance_after,reference_type,reference_id,description
  ) values (
    p_user_id,'purchase',-charge,'SYP',new_balance,'kmcard_order',oid,'شراء باقة تطبيق من المحفظة'
  ) returning id into txid;

  return jsonb_build_object(
    'id',oid,'order_number',order_no,'order_uuid',ouuid,
    'charged_syp',charge,'balance_after',new_balance
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) TO service_role;

-- A transaction-scoped advisory lock blocks concurrent duplicates without deleting historical rows.
CREATE OR REPLACE FUNCTION public.guard_topup_payment_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  normalized text := lower(trim(coalesce(NEW.payment_number,'')));
begin
  if normalized = '' then raise exception 'أدخل رمز الدفع'; end if;
  perform pg_advisory_xact_lock(hashtextextended(normalized, 930271));
  if exists (
    select 1 from public.topup_requests t
     where lower(trim(t.payment_number)) = normalized
       and (NEW.id is null or t.id <> NEW.id)
  ) then
    raise exception 'رمز الدفع مستخدم سابقًا';
  end if;
  return NEW;
end;
$function$;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname='topup_payment_number_guard'
       AND tgrelid='public.topup_requests'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER topup_payment_number_guard
      BEFORE INSERT OR UPDATE OF payment_number ON public.topup_requests
      FOR EACH ROW EXECUTE FUNCTION public.guard_topup_payment_number();
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION public.submit_topup_request(
  p_amount numeric,
  p_currency text,
  p_payment_number text,
  p_receipt_path text DEFAULT NULL::text
) RETURNS public.topup_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_row public.topup_requests;
  v_payment_number text := lower(trim(coalesce(p_payment_number,'')));
begin
  if auth.uid() is null then raise exception 'سجّل الدخول أولًا'; end if;
  if p_currency not in ('SYP','USD') then raise exception 'عملة غير صالحة'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'مبلغ غير صالح'; end if;
  if (p_currency='SYP' and p_amount < 500) or (p_currency='USD' and p_amount < 5) then
    raise exception 'الحد الأدنى للشحن هو 500 ليرة سورية أو 5 دولارات';
  end if;
  if v_payment_number = '' then raise exception 'أدخل رمز الدفع'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_payment_number, 930271));
  if exists (
    select 1 from public.topup_requests t
     where lower(trim(t.payment_number)) = v_payment_number
  ) then
    raise exception 'رمز الدفع مستخدم سابقًا';
  end if;

  insert into public.topup_requests(user_id,amount,currency,payment_number,receipt_path)
  values(auth.uid(),round(p_amount,2),p_currency,trim(p_payment_number),p_receipt_path)
  returning * into v_row;
  return v_row;
end;
$function$;
