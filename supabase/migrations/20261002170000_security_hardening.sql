BEGIN;

-- All paid game/transfer orders now enter through the authenticated Edge Function.
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
  sale_key text := p_product_id::text || ':' || regexp_replace(regexp_replace(to_char(p_quantity, 'FM999999999.999999'), '0+$', ''), '\.$', '');
BEGIN
  IF coalesce(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF uid IS NULL OR p_product_id IS NULL OR p_product_id <= 0 THEN
    RAISE EXCEPTION 'بيانات المنتج غير صالحة';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 1000000000 THEN
    RAISE EXCEPTION 'الكمية غير صالحة';
  END IF;
  IF p_price_usd IS NULL OR p_price_usd <= 0 OR p_price_usd > 1000000000000 THEN
    RAISE EXCEPTION 'تكلفة المزوّد غير صالحة';
  END IF;
  IF p_params IS NULL OR jsonb_typeof(p_params) <> 'object' THEN
    RAISE EXCEPTION 'بيانات الطلب غير صالحة';
  END IF;

  SELECT * INTO existing
  FROM public.kmcard_orders
  WHERE order_uuid = ouuid AND user_id = uid;
  IF FOUND THEN
    IF existing.product_id <> p_product_id OR existing.quantity <> p_quantity THEN
      RAISE EXCEPTION 'مفتاح الطلب مستخدم لمنتج أو كمية مختلفة';
    END IF;
    RETURN jsonb_build_object(
      'id', existing.id,
      'order_number', existing.order_number,
      'order_uuid', existing.order_uuid,
      'charged_syp', existing.charged_syp,
      'status', existing.status,
      'provider_status', existing.provider_status,
      'provider_order_id', existing.provider_order_id,
      'already_exists', true
    );
  END IF;

  SELECT value INTO raw FROM public.settings WHERE key = 'km_sale_prices';
  BEGIN
    prices := coalesce(raw, '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    prices := '{}'::jsonb;
  END;
  expected := (prices->>sale_key)::numeric;
  IF expected IS NULL OR expected <= 0 OR expected > 1000000000000 THEN
    RAISE EXCEPTION 'سعر البيع غير مضبوط لهذه الباقة؛ لم يتم الخصم';
  END IF;
  IF p_sale_price_syp IS NOT NULL AND round(p_sale_price_syp, 2) <> round(expected, 2) THEN
    RAISE EXCEPTION 'سعر الباقة تغيّر؛ حدّث الصفحة قبل الشراء';
  END IF;

  charge := round(expected, 2);
  INSERT INTO public.wallets(user_id) VALUES (uid) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.wallets WHERE user_id = uid FOR UPDATE;
  IF w.balance_syp < charge THEN
    RAISE EXCEPTION 'الرصيد غير كافٍ، اشحن محفظتك أولًا';
  END IF;
  new_balance := w.balance_syp - charge;
  UPDATE public.wallets SET balance_syp = new_balance, updated_at = now() WHERE user_id = uid;

  order_no := 'KM-' || to_char(now(), 'YYYYMMDD') || '-' || lpad((floor(random() * 900000) + 100000)::text, 6, '0');
  INSERT INTO public.kmcard_orders(
    order_number, user_id, product_id, product_name, category_name,
    quantity, params, price_usd, charged_syp, order_uuid
  ) VALUES (
    order_no, uid, p_product_id, coalesce(p_product_name, ''), coalesce(p_category_name, ''),
    p_quantity, p_params, p_price_usd, charge, ouuid
  ) RETURNING id INTO oid;

  INSERT INTO public.wallet_transactions(
    user_id, type, amount, currency, balance_after, reference_type, reference_id, description
  ) VALUES (
    uid, 'purchase', -charge, 'SYP', new_balance, 'kmcard_order', oid, 'شراء باقة من المحفظة'
  ) RETURNING id INTO txid;

  RETURN jsonb_build_object(
    'id', oid,
    'order_number', order_no,
    'order_uuid', ouuid,
    'charged_syp', charge,
    'balance_after', new_balance
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_kmcard_order_internal(uuid,bigint,text,text,numeric,numeric,jsonb,uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_kmcard_order_internal(uuid,bigint,text,text,numeric,numeric,jsonb,uuid,numeric) TO service_role;

-- Do not let a customer call the older wallet RPC directly; it bypasses live product validation and rate limiting.
REVOKE ALL ON FUNCTION public.create_kmcard_order(bigint,text,text,numeric,numeric,jsonb,uuid,numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_kmcard_chat_order(uuid,bigint,text,text,numeric,numeric,jsonb,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_kmcard_order(bigint,text,text,jsonb,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_kmcard_order(bigint,text,text,jsonb,boolean) TO service_role;

-- Enforce second-factor PIN only for actual admins; serialize attempts and retain the three-try lockout.
CREATE OR REPLACE FUNCTION public.verify_admin_pin(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  uid uuid := auth.uid();
  h text;
  a public.admin_pin_attempts%rowtype;
  ok boolean := false;
  rem integer;
BEGIN
  IF uid IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unauthorized');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text || ':admin-pin', 761233));
  INSERT INTO public.admin_pin_attempts(user_id, attempts, locked_until)
  VALUES (uid, 0, NULL) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO a FROM public.admin_pin_attempts WHERE user_id = uid FOR UPDATE;
  IF a.locked_until IS NOT NULL AND a.locked_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked', 'remaining', 0);
  END IF;
  IF a.locked_until IS NOT NULL AND a.locked_until <= now() THEN
    UPDATE public.admin_pin_attempts SET attempts = 0, locked_until = NULL WHERE user_id = uid;
    a.attempts := 0;
    a.locked_until := NULL;
  END IF;
  IF coalesce(length(p_pin), 0) BETWEEN 1 AND 20 THEN
    SELECT pin_hash INTO h FROM public.admin_security WHERE id = true;
    ok := h IS NOT NULL AND h = extensions.crypt(p_pin, h);
  END IF;
  IF ok THEN
    DELETE FROM public.admin_pin_attempts WHERE user_id = uid;
    RETURN jsonb_build_object('ok', true, 'remaining', 3);
  END IF;
  rem := greatest(0, 3 - a.attempts - 1);
  UPDATE public.admin_pin_attempts
  SET attempts = a.attempts + 1,
      locked_until = CASE WHEN a.attempts + 1 >= 3 THEN now() + interval '15 minutes' ELSE NULL END
  WHERE user_id = uid;
  RETURN jsonb_build_object(
    'ok', false,
    'reason', CASE WHEN rem = 0 THEN 'locked' ELSE 'invalid' END,
    'remaining', rem
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.verify_admin_pin(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_pin(text) TO authenticated;

-- Enforce visible game/package status and valid positive prices inside the legacy wallet RPC.
CREATE OR REPLACE FUNCTION public.purchase_with_wallet(
  p_game_id bigint,
  p_package_id bigint,
  p_player_id text,
  p_customer_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  uid uuid := auth.uid();
  pkg public.packages;
  w public.wallets;
  new_balance numeric;
  oid bigint;
  order_no text;
  txid bigint;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'سجّل الدخول أولًا'; END IF;
  IF length(trim(coalesce(p_player_id, ''))) = 0 OR length(p_player_id) > 100
     OR length(trim(coalesce(p_customer_name, ''))) = 0 OR length(p_customer_name) > 120 THEN
    RAISE EXCEPTION 'أكمل بيانات الطلب';
  END IF;
  SELECT p.* INTO pkg
  FROM public.packages p
  JOIN public.games g ON g.id = p.game_id
  WHERE p.id = p_package_id AND p.game_id = p_game_id AND p.visible = true AND g.visible = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'الباقة غير متاحة'; END IF;
  IF pkg.price_amount IS NULL OR pkg.price_amount <= 0 OR pkg.price_amount > 1000000000
     OR pkg.currency NOT IN ('SYP', 'USD') THEN
    RAISE EXCEPTION 'سعر الباقة غير صالح';
  END IF;

  INSERT INTO public.wallets(user_id) VALUES (uid) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM public.wallets WHERE user_id = uid FOR UPDATE;
  IF pkg.currency = 'USD' THEN
    IF w.balance_usd < pkg.price_amount THEN RAISE EXCEPTION 'الرصيد غير كافٍ، اشحن المحفظة أولًا'; END IF;
    new_balance := w.balance_usd - pkg.price_amount;
    UPDATE public.wallets SET balance_usd = new_balance, updated_at = now() WHERE user_id = uid;
  ELSE
    IF w.balance_syp < pkg.price_amount THEN RAISE EXCEPTION 'الرصيد غير كافٍ، اشحن المحفظة أولًا'; END IF;
    new_balance := w.balance_syp - pkg.price_amount;
    UPDATE public.wallets SET balance_syp = new_balance, updated_at = now() WHERE user_id = uid;
  END IF;

  order_no := 'BC-' || to_char(now(), 'YYYYMMDD') || '-' || lpad((floor(random() * 900000) + 100000)::text, 6, '0');
  INSERT INTO public.orders(order_number,user_id,game_id,package_id,player_id,customer_name,payment_number,status)
  VALUES (order_no, uid, p_game_id, p_package_id, trim(p_player_id), trim(p_customer_name), 'wallet', 'pending')
  RETURNING id INTO oid;
  INSERT INTO public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
  VALUES (uid, 'purchase', -pkg.price_amount, pkg.currency, new_balance, 'order', oid, 'شراء من المحفظة')
  RETURNING id INTO txid;
  UPDATE public.orders SET wallet_transaction_id = txid WHERE id = oid;
  RETURN jsonb_build_object('order_id', oid, 'order_number', order_no, 'balance_after', new_balance, 'currency', pkg.currency);
END;
$function$;
REVOKE ALL ON FUNCTION public.purchase_with_wallet(bigint,bigint,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_with_wallet(bigint,bigint,text,text) TO authenticated;

-- Keep order rejection/refund idempotent and report a refund only when a ledger entry was added.
CREATE OR REPLACE FUNCTION public.admin_update_order_status(p_order_id bigint, p_status text, p_note text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  o public.orders;
  tx public.wallet_transactions;
  w public.wallets;
  refund numeric;
  new_balance numeric;
  did_refund boolean := false;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF p_status NOT IN ('pending','processing','completed','rejected') THEN RAISE EXCEPTION 'حالة الطلب غير صالحة'; END IF;
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود'; END IF;
  IF o.status = 'rejected' AND p_status <> 'rejected' THEN RAISE EXCEPTION 'لا يمكن إعادة فتح طلب مرفوض بعد إعادة الرصيد'; END IF;
  IF o.status = 'completed' AND p_status = 'rejected' THEN RAISE EXCEPTION 'لا يمكن رفض طلب مكتمل'; END IF;
  IF p_status = 'rejected' AND o.status <> 'rejected' AND o.wallet_transaction_id IS NOT NULL THEN
    SELECT * INTO tx FROM public.wallet_transactions WHERE id = o.wallet_transaction_id;
    IF FOUND AND tx.amount < 0 AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions WHERE reference_type = 'order_refund' AND reference_id = o.id
    ) THEN
      refund := -tx.amount;
      INSERT INTO public.wallets(user_id) VALUES (o.user_id) ON CONFLICT DO NOTHING;
      SELECT * INTO w FROM public.wallets WHERE user_id = o.user_id FOR UPDATE;
      IF tx.currency = 'USD' THEN
        new_balance := w.balance_usd + refund;
        UPDATE public.wallets SET balance_usd = new_balance, updated_at = now() WHERE user_id = o.user_id;
      ELSE
        new_balance := w.balance_syp + refund;
        UPDATE public.wallets SET balance_syp = new_balance, updated_at = now() WHERE user_id = o.user_id;
      END IF;
      INSERT INTO public.wallet_transactions(user_id,type,amount,currency,balance_after,reference_type,reference_id,description)
      VALUES (o.user_id, 'adjustment', refund, tx.currency, new_balance, 'order_refund', o.id, 'إرجاع قيمة الطلب المرفوض إلى محفظة المستخدم');
      did_refund := true;
    END IF;
  END IF;
  UPDATE public.orders SET status = p_status, updated_at = now() WHERE id = o.id RETURNING * INTO o;
  RETURN jsonb_build_object('id', o.id, 'status', o.status, 'refunded', did_refund);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_update_order_status(bigint,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_order_status(bigint,text,text) TO authenticated;

-- Bound and normalize top-up inputs even if a modified client calls the RPC directly.
CREATE OR REPLACE FUNCTION public.submit_topup_request(
  p_amount numeric,
  p_currency text,
  p_payment_number text,
  p_receipt_path text DEFAULT NULL
) RETURNS public.topup_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  uid uuid := auth.uid();
  v_row public.topup_requests;
  v_payment_number text := translate(trim(coalesce(p_payment_number, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'سجّل الدخول أولًا'; END IF;
  IF p_currency NOT IN ('SYP','USD') THEN RAISE EXCEPTION 'عملة غير صالحة'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000 THEN RAISE EXCEPTION 'مبلغ غير صالح'; END IF;
  IF (p_currency = 'SYP' AND p_amount < 500) OR (p_currency = 'USD' AND p_amount < 5) THEN
    RAISE EXCEPTION 'الحد الأدنى للشحن هو 500 ليرة سورية أو 5 دولارات';
  END IF;
  IF v_payment_number = '' OR length(v_payment_number) > 120 OR v_payment_number !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'رقم عملية شام كاش يجب أن يحتوي أرقامًا فقط';
  END IF;
  IF p_receipt_path IS NOT NULL AND (
    length(p_receipt_path) > 512
    OR split_part(p_receipt_path, '/', 1) <> uid::text
    OR p_receipt_path ~ '(^|/)\.\.?(/|$)'
    OR p_receipt_path ~ '^[A-Za-z][A-Za-z0-9+.-]*://'
    OR position(chr(92) in p_receipt_path) > 0
  ) THEN
    RAISE EXCEPTION 'مسار الإيصال غير صالح';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_payment_number, 930271));
  IF EXISTS (
    SELECT 1 FROM public.topup_requests t
    WHERE translate(trim(t.payment_number), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') = v_payment_number
  ) THEN
    RAISE EXCEPTION 'رمز الدفع مستخدم سابقًا';
  END IF;
  INSERT INTO public.topup_requests(user_id,amount,currency,payment_number,receipt_path)
  VALUES (uid, round(p_amount, 2), p_currency, v_payment_number, p_receipt_path)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.submit_topup_request(numeric,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_topup_request(numeric,text,text,text) TO authenticated;

-- Protect anonymous support submission from oversized payloads and notification flooding.
CREATE OR REPLACE FUNCTION public.basecard_guard_new_requests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  uid uuid;
  n integer;
  is_mfa boolean;
  v_contact text;
BEGIN
  uid := coalesce(NEW.user_id, auth.uid());
  IF TG_TABLE_NAME = 'messages' THEN
    IF length(trim(coalesce(NEW.name, ''))) NOT BETWEEN 1 AND 120
       OR length(trim(coalesce(NEW.contact, ''))) NOT BETWEEN 1 AND 200
       OR length(trim(coalesce(NEW.message, ''))) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'بيانات الرسالة خارج الحدود المسموحة';
    END IF;
    IF uid IS NULL THEN
      v_contact := lower(trim(NEW.contact));
      PERFORM pg_advisory_xact_lock(hashtextextended('basecard-support:' || v_contact, 930279));
      SELECT count(*) INTO n FROM public.messages
      WHERE lower(trim(contact)) = v_contact AND created_at > now() - interval '15 minutes';
      IF n >= 3 THEN RAISE EXCEPTION 'انتظر قليلًا قبل إرسال رسالة أخرى'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('basecard-anonymous-support-global', 930280));
      SELECT count(*) INTO n FROM public.messages
      WHERE user_id IS NULL AND created_at > now() - interval '1 minute';
      IF n >= 20 THEN RAISE EXCEPTION 'تعذر إرسال الرسالة الآن؛ حاول بعد قليل'; END IF;
    END IF;
  END IF;
  IF uid IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  IF TG_TABLE_NAME IN ('orders','kmcard_orders','topup_requests') THEN
    SELECT EXISTS(SELECT 1 FROM auth.mfa_factors WHERE user_id = uid AND status = 'verified') INTO is_mfa;
    IF is_mfa AND uid = auth.uid() AND coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' THEN
      RAISE EXCEPTION 'أكمل التحقق الثنائي قبل تنفيذ العملية';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('orders','kmcard_orders') THEN
    SELECT (SELECT count(*) FROM public.orders WHERE user_id = uid AND created_at > now() - interval '10 minutes')
         + (SELECT count(*) FROM public.kmcard_orders WHERE user_id = uid AND created_at > now() - interval '10 minutes') INTO n;
    IF n >= 10 THEN RAISE EXCEPTION 'تجاوزت حد الطلبات المؤقت؛ انتظر قليلًا ثم حاول مجددًا'; END IF;
  ELSIF TG_TABLE_NAME = 'topup_requests' THEN
    SELECT count(*) INTO n FROM public.topup_requests WHERE user_id = uid AND created_at > now() - interval '1 hour';
    IF n >= 5 THEN RAISE EXCEPTION 'تجاوزت حد طلبات شحن الرصيد؛ حاول بعد قليل'; END IF;
  ELSIF TG_TABLE_NAME = 'messages' THEN
    SELECT count(*) INTO n FROM public.messages WHERE user_id = uid AND created_at > now() - interval '1 hour';
    IF n >= 5 THEN RAISE EXCEPTION 'تجاوزت حد الرسائل؛ حاول بعد قليل'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.basecard_guard_new_requests() FROM PUBLIC, anon, authenticated;

-- Keep role changes blocked at both the ACL and trigger layers.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.wallets FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.wallet_transactions FROM PUBLIC, anon, authenticated;

-- Customers and admins must use the transactional RPCs for orders, top-ups, and KM orders.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.orders FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.topup_requests FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.kmcard_orders FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS orders_insert_own ON public.orders;
DROP POLICY IF EXISTS orders_admin_update ON public.orders;
DROP POLICY IF EXISTS topup_self_insert ON public.topup_requests;
DROP POLICY IF EXISTS topup_admin_update ON public.topup_requests;
DROP POLICY IF EXISTS kmcard_orders_admin_update ON public.kmcard_orders;

-- Public package reads expose retail data only; wholesale costs/provider metadata are never selectable.
REVOKE SELECT ON TABLE public.packages FROM PUBLIC, anon, authenticated;
GRANT SELECT (id,game_id,name,price,price_amount,currency,note,visible,sort_order,created_at)
  ON TABLE public.packages TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.packages FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.games, public.settings, public.site_sections FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.packages TO service_role;

-- Restrict order reads to the fields used by the customer tracker and admin screen.
REVOKE SELECT ON TABLE public.orders FROM PUBLIC, anon, authenticated;
GRANT SELECT (id,order_number,user_id,game_id,package_id,player_id,customer_name,payment_number,receipt_path,status,created_at,updated_at,wallet_transaction_id)
  ON TABLE public.orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders TO service_role;

-- Hide KM provider cost, raw provider response, encrypted parameters, and internal notes from direct table reads.
REVOKE SELECT ON TABLE public.kmcard_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT (user_id,order_number,status,provider_status,category_name,product_name,charged_syp,created_at,updated_at)
  ON TABLE public.kmcard_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.kmcard_orders TO service_role;

-- Top-up customers see their own payment/status fields, never internal review notes or reviewer identifiers.
REVOKE SELECT ON TABLE public.topup_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT (id,user_id,amount,currency,payment_number,status,created_at)
  ON TABLE public.topup_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.topup_requests TO service_role;

-- Keep private admin-only tables inaccessible to anon and authenticated roles.
REVOKE ALL ON TABLE public.admin_pin_attempts, public.admin_security, public.admin_push_event_queue,
  public.admin_push_subscriptions, public.kmcard_order_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_push_event_queue,
  public.admin_push_subscriptions, public.kmcard_order_audit TO service_role;

-- These reporting and review procedures require authenticated users; each still checks the admin role.
REVOKE ALL ON FUNCTION public.admin_daily_profit_summary(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_profit_summary(date) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_list_topup_requests(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_topup_requests(text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_list_topup_requests_with_users(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_topup_requests_with_users(text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_list_kmcard_order_audit(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_kmcard_order_audit(integer) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_review_topup(bigint,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_topup(bigint,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_adjust_wallet(uuid,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_wallet(uuid,numeric,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.my_today_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_today_orders() TO authenticated;

-- Trigger-only helpers are not callable through the public API.
REVOKE ALL ON FUNCTION public.protect_profile_privileges() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_wallet() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_topup_payment_number_digits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_topup_payment_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.queue_admin_push_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_kmcard_order_attempt(uuid,uuid,bigint,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_kmcard_order_attempt(uuid,uuid,bigint,numeric,integer) TO service_role;

-- Private receipt uploads are user-folder/rate/size limited; only admins may read them.
REVOKE ALL ON FUNCTION public.can_upload_receipt(text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_upload_receipt(text,jsonb) TO authenticated;
DROP POLICY IF EXISTS receipts_upload_own ON storage.objects;
CREATE POLICY receipts_upload_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'receipts'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.can_upload_receipt(name, metadata)
  );
DROP POLICY IF EXISTS receipts_admin_read ON storage.objects;
CREATE POLICY receipts_admin_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'receipts' AND public.is_admin());

-- Direct support messages remain available without login but are bounded server-side.
ALTER TABLE public.messages ADD CONSTRAINT messages_name_length_check CHECK (length(trim(name)) BETWEEN 1 AND 120);
ALTER TABLE public.messages ADD CONSTRAINT messages_contact_length_check CHECK (length(trim(contact)) BETWEEN 1 AND 200);
ALTER TABLE public.messages ADD CONSTRAINT messages_body_length_check CHECK (length(trim(message)) BETWEEN 1 AND 2000);
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages FROM PUBLIC, anon;
REVOKE UPDATE ON TABLE public.messages FROM authenticated;
GRANT INSERT ON TABLE public.messages TO anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.messages TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
