-- Secure admin-only listing that includes the requesting user's display name and email.
create or replace function public.admin_list_topup_requests_with_users(p_status text default null)
returns table (
  id bigint,
  user_id uuid,
  amount numeric,
  currency text,
  payment_number text,
  receipt_path text,
  status text,
  admin_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz,
  user_name text,
  user_email text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id,
    t.user_id,
    t.amount,
    t.currency,
    t.payment_number,
    t.receipt_path,
    t.status,
    t.admin_note,
    t.reviewed_by,
    t.reviewed_at,
    t.created_at,
    coalesce(nullif(trim(p.name), ''), nullif(trim(p.email), ''), 'مستخدم')::text as user_name,
    coalesce(nullif(trim(p.email), ''), '')::text as user_email
  from public.topup_requests as t
  left join public.profiles as p on p.id = t.user_id
  where public.is_admin()
    and (p_status is null or t.status = p_status)
  order by t.created_at desc, t.id desc;
$$;

revoke all on function public.admin_list_topup_requests_with_users(text) from public, anon;
grant execute on function public.admin_list_topup_requests_with_users(text) to authenticated;
