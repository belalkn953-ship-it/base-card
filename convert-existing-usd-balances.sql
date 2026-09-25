-- One-time conversion of legacy USD wallet balances into the spendable SYP wallet.
-- Uses the currently saved exchange rate; records both sides without changing any other ledger fields.
do $migration$
declare
  v_rate numeric;
  r record;
  v_usd numeric;
  v_syp numeric;
  v_new_balance numeric;
begin
  select coalesce(nullif(value,'')::numeric,130)
    into v_rate
    from public.settings
    where key='usd_to_syp_rate'
    for share;
  v_rate := coalesce(v_rate,130);
  if v_rate <= 0 or v_rate > 100000 then
    raise exception 'سعر الصرف غير صالح؛ لم يتم تحويل أي رصيد';
  end if;

  for r in
    select user_id,balance_usd,balance_syp
      from public.wallets
      where balance_usd <> 0
      order by user_id
      for update
  loop
    v_usd := round(r.balance_usd,2);
    v_syp := round(v_usd * v_rate,2);
    if v_syp <= 0 or v_syp > 999999999999.99 then
      raise exception 'قيمة تحويل خارج النطاق؛ تم إلغاء العملية كاملة';
    end if;
    v_new_balance := r.balance_syp + v_syp;
    if v_new_balance > 999999999999.99 then
      raise exception 'رصيد بعد التحويل خارج النطاق؛ تم إلغاء العملية كاملة';
    end if;

    update public.wallets
      set balance_syp=v_new_balance,balance_usd=0,updated_at=now()
      where user_id=r.user_id;

    insert into public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,description)
    values(r.user_id,'adjustment',-v_usd,'USD',0,'usd_balance_conversion',
      'تحويل الرصيد الدولاري إلى الليرة السورية بسعر '||v_rate::text||' ل.س لكل دولار');
    insert into public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,description)
    values(r.user_id,'adjustment',v_syp,'SYP',v_new_balance,'usd_balance_conversion',
      'تحويل الرصيد: '||v_usd::text||' دولار × '||v_rate::text||' = '||v_syp::text||' ل.س جديدة');
  end loop;
end;
$migration$;
