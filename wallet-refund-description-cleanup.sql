-- Keep provider rejection refunds idempotent while using provider-neutral ledger text.
create or replace function public.create_kmcard_order(
  p_product_id bigint,
  p_product_name text,
  p_category_name text,
  p_quantity numeric,
  p_price_usd numeric,
  p_params jsonb,
  p_order_uuid uuid default null,
  p_sale_price_syp numeric default null
) returns jsonb
language plpgsql security definer set search_path=public
as $function$
declare
  uid uuid:=auth.uid();
  w public.wallets;
  charge numeric;
  new_balance numeric;
  oid bigint;
  order_no text;
  ouuid uuid:=coalesce(p_order_uuid,gen_random_uuid());
  txid bigint;
  existing public.kmcard_orders;
  raw text;
  prices jsonb;
  expected numeric;
  sale_key text:=p_product_id::text||':'||regexp_replace(regexp_replace(to_char(p_quantity,'FM999999999.999999'),'0+$',''),'\.$','');
begin
  if uid is null then raise exception 'سجّل الدخول أولًا قبل الشراء'; end if;
  select * into existing from public.kmcard_orders where order_uuid=ouuid and user_id=uid;
  if found then
    return jsonb_build_object('id',existing.id,'order_number',existing.order_number,'order_uuid',existing.order_uuid,
      'charged_syp',existing.charged_syp,'status',existing.status,'provider_status',existing.provider_status,
      'provider_order_id',existing.provider_order_id,'already_exists',true);
  end if;
  if coalesce(p_quantity,0)<=0 or p_params is null or jsonb_typeof(p_params)<>'object' then
    raise exception 'بيانات الطلب غير صالحة';
  end if;
  select value into raw from public.settings where key='km_sale_prices';
  begin prices:=coalesce(raw,'{}')::jsonb; exception when others then prices:='{}'::jsonb; end;
  expected:=coalesce((prices->>sale_key)::numeric,(prices->>(p_product_id::text))::numeric);
  if expected is null or expected<=0 then raise exception 'سعر البيع غير مضبوط لهذه الباقة؛ لم يتم الخصم'; end if;
  if p_sale_price_syp is not null and round(p_sale_price_syp,2)<>round(expected,2) then
    raise exception 'سعر الباقة تغيّر؛ حدّث الصفحة قبل الشراء';
  end if;
  charge:=round(expected,2);
  insert into public.wallets(user_id) values(uid) on conflict do nothing;
  select * into w from public.wallets where user_id=uid for update;
  if w.balance_syp < charge then raise exception 'الرصيد غير كافٍ، اشحن محفظتك أولًا'; end if;
  new_balance:=w.balance_syp-charge;
  update public.wallets set balance_syp=new_balance,updated_at=now() where user_id=uid;
  order_no:='KM-'||to_char(now(),'YYYYMMDD')||'-'||lpad((floor(random()*900000)+100000)::text,6,'0');
  insert into public.kmcard_orders(order_number,user_id,product_id,product_name,category_name,quantity,params,price_usd,charged_syp,order_uuid)
  values(order_no,uid,p_product_id,coalesce(p_product_name,''),coalesce(p_category_name,''),p_quantity,p_params,coalesce(p_price_usd,0),charge,ouuid)
  returning id into oid;
  insert into public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
  values(uid,'purchase',-charge,'SYP',new_balance,'kmcard_order',oid,'شراء باقة من المحفظة') returning id into txid;
  return jsonb_build_object('id',oid,'order_number',order_no,'order_uuid',ouuid,'charged_syp',charge,'balance_after',new_balance);
end; $function$;

create or replace function public.finalize_kmcard_order(
  p_id bigint,
  p_status text,
  p_provider_order_id text default null,
  p_response jsonb default '{}'::jsonb,
  p_refund boolean default false
) returns jsonb
language plpgsql security definer set search_path=public
as $function$
declare
  o public.kmcard_orders;
  w public.wallets;
  b numeric;
  mapped text;
  provider_state text:=lower(coalesce(p_status,''));
  did_refund boolean:=false;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' and not public.is_admin() then raise exception 'غير مصرح'; end if;
  if provider_state not in ('pending','processing','completed','rejected','refunded','accept','wait','reject') then raise exception 'حالة المزود غير صالحة'; end if;
  mapped:=case provider_state when 'accept' then 'completed' when 'wait' then 'processing' when 'reject' then 'rejected' else provider_state end;
  select * into o from public.kmcard_orders where id=p_id for update;
  if not found then raise exception 'طلب الشحن غير موجود'; end if;
  -- Refund only once; the unique ledger reference prevents double credit on retries.
  if (mapped='rejected' or p_refund) and o.status<>'refunded' and not exists(select 1 from public.wallet_transactions where reference_type='kmcard_refund' and reference_id=o.id) then
    insert into public.wallets(user_id) values(o.user_id) on conflict do nothing;
    select * into w from public.wallets where user_id=o.user_id for update;
    b:=w.balance_syp+o.charged_syp;
    update public.wallets set balance_syp=b,updated_at=now() where user_id=o.user_id;
    insert into public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
    values(o.user_id,'adjustment',o.charged_syp,'SYP',b,'kmcard_refund',o.id,'تم إرجاع مبلغ الطلب المرفوض إلى المحفظة');
    did_refund:=true;
  end if;
  update public.kmcard_orders set status=mapped,
    provider_status=provider_state, provider_order_id=coalesce(p_provider_order_id,provider_order_id),
    provider_response=coalesce(p_response,'{}'::jsonb),updated_at=now() where id=o.id returning * into o;
  return jsonb_build_object('id',o.id,'status',o.status,'provider_status',o.provider_status,'refunded',did_refund);
end; $function$;

-- Rewrite only display text; amounts, balances, references, and timestamps remain unchanged.
with changed as (
  update public.wallet_transactions
  set description = case
    when description = 'شراء تلقائي من KM Card' then 'شراء باقة من المحفظة'
    when description in ('إرجاع مبلغ طلب KM Card المرفوض','إرجاع قيمة طلب KM Card المرفوض') then 'تم إرجاع مبلغ الطلب المرفوض إلى المحفظة'
    when description like 'تصحيح فرق خصم طلب KM Card:%' then 'تصحيح فرق خصم الطلب: السعر الصحيح 145 ليرة سورية جديدة'
    when description = 'إرجاع طلبين KM Card معلقين بناءً على طلب المستخدم' then 'إرجاع مبالغ الطلبات المعلقة بناءً على طلب المستخدم'
    else trim(regexp_replace(description, '(?i)KM[[:space:]]*Card|كيم[[:space:]]*كارد', 'الطلب', 'g'))
  end
  where description ilike '%KM Card%' or description ilike '%كيم كارد%'
  returning id
)
select count(*) as descriptions_updated from changed;
