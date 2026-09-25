-- USD wallet adjustments are input in USD but always credited/debited in the SYP wallet.
create or replace function public.admin_adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_currency text,
  p_note text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  w public.wallets;
  exchange_rate numeric := 1;
  syp_delta numeric;
  new_balance numeric;
  tx_description text;
  safe_note text := nullif(trim(coalesce(p_note,'')), '');
begin
  if not public.is_admin() then raise exception 'غير مصرح'; end if;
  if p_user_id is null or p_amount is null or p_amount = 0 or p_currency not in ('SYP','USD') then
    raise exception 'بيانات الرصيد غير صالحة';
  end if;

  insert into public.wallets(user_id) values(p_user_id) on conflict do nothing;
  select * into w from public.wallets where user_id=p_user_id for update;

  if p_currency='USD' then
    select coalesce(nullif(value,'')::numeric,130)
      into exchange_rate
      from public.settings
      where key='usd_to_syp_rate';
    exchange_rate := coalesce(exchange_rate,130);
    if exchange_rate <= 0 or exchange_rate > 100000 then
      raise exception 'سعر الصرف غير صالح؛ راجع الإعدادات';
    end if;
    syp_delta := round(p_amount * exchange_rate,2);
  else
    syp_delta := round(p_amount,2);
  end if;

  if syp_delta = 0 or abs(syp_delta) > 999999999999.99 then
    raise exception 'مبلغ الرصيد خارج النطاق المسموح';
  end if;
  new_balance := w.balance_syp + syp_delta;
  if new_balance < 0 then raise exception 'لا يمكن أن يصبح الرصيد سالبًا'; end if;
  if new_balance > 999999999999.99 then raise exception 'الرصيد يتجاوز الحد المسموح'; end if;

  update public.wallets
    set balance_syp=new_balance, updated_at=now()
    where user_id=p_user_id;

  if p_currency='USD' then
    tx_description := (case when syp_delta > 0 then 'إضافة' else 'خصم' end)
      || ' رصيد بالدولار وتحويله إلى الليرة السورية: '
      || abs(p_amount)::text || ' دولار × ' || exchange_rate::text || ' = '
      || abs(syp_delta)::text || ' ل.س جديدة'
      || case when safe_note is null then '' else ' — ' || safe_note end;
  else
    tx_description := coalesce(safe_note,'تعديل يدوي من الإدارة');
  end if;

  insert into public.wallet_transactions(user_id,type,amount,currency,balance_after,description)
  values(p_user_id,'adjustment',syp_delta,'SYP',new_balance,tx_description);

  return jsonb_build_object(
    'user_id',p_user_id,
    'balance_after',new_balance,
    'balance_currency','SYP',
    'input_amount',p_amount,
    'input_currency',p_currency,
    'converted_amount_syp',syp_delta,
    'exchange_rate',exchange_rate
  );
end;
$function$;

-- This RPC is for signed-in administrators only; the function also enforces is_admin().
revoke all on function public.admin_adjust_wallet(uuid,numeric,text,text) from public, anon;
grant execute on function public.admin_adjust_wallet(uuid,numeric,text,text) to authenticated;

notify pgrst, 'reload schema';
