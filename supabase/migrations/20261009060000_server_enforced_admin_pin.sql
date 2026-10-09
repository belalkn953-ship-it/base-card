BEGIN;

-- The admin PIN must protect database operations, not only the browser UI.
CREATE TABLE IF NOT EXISTS public.admin_pin_sessions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_pin_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_pin_sessions FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_pin_session_valid(p_session_token text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR p_session_token IS NULL OR p_session_token !~ '^[0-9a-f-]{36}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.admin_pin_sessions s ON s.user_id = p.id
    WHERE p.id = uid
      AND p.role = 'admin'
      AND s.expires_at > now()
      AND s.token_hash = encode(extensions.digest(convert_to(p_session_token, 'UTF8'), 'sha256'), 'hex')
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_pin_session_valid(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_pin_session_valid(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  uid uuid := auth.uid();
  request_headers jsonb;
  session_token text := '';
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = uid AND role = 'admin'
  ) THEN
    RETURN false;
  END IF;
  BEGIN
    request_headers := nullif(current_setting('request.headers', true), '')::jsonb;
    session_token := coalesce(request_headers ->> 'x-basecard-admin-pin-session', '');
  EXCEPTION WHEN OTHERS THEN
    session_token := '';
  END;
  IF session_token !~ '^[0-9a-f-]{36}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.admin_pin_sessions s
    WHERE s.user_id = uid
      AND s.expires_at > now()
      AND s.token_hash = encode(extensions.digest(convert_to(session_token, 'UTF8'), 'sha256'), 'hex')
  );
END;
$function$;

-- PIN verification issues a short-lived, random session token; only its hash is stored.
CREATE OR REPLACE FUNCTION public.verify_admin_pin(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  uid uuid := auth.uid();
  h text;
  a public.admin_pin_attempts%rowtype;
  ok boolean := false;
  rem integer;
  session_token text;
  session_expiry timestamptz;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = uid AND role = 'admin'
  ) THEN
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
    session_token := gen_random_uuid()::text;
    session_expiry := now() + interval '15 minutes';
    INSERT INTO public.admin_pin_sessions(user_id, token_hash, expires_at, created_at)
    VALUES (
      uid,
      encode(extensions.digest(convert_to(session_token, 'UTF8'), 'sha256'), 'hex'),
      session_expiry,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE
      SET token_hash = EXCLUDED.token_hash,
          expires_at = EXCLUDED.expires_at,
          created_at = EXCLUDED.created_at;
    DELETE FROM public.admin_pin_attempts WHERE user_id = uid;
    DELETE FROM public.admin_pin_sessions WHERE expires_at <= now();
    RETURN jsonb_build_object(
      'ok', true,
      'remaining', 3,
      'session_token', session_token,
      'expires_at', session_expiry
    );
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

-- Close the one admin listing RPC that used a direct role-only check.
CREATE OR REPLACE FUNCTION public.admin_list_topup_requests(p_status text DEFAULT NULL)
RETURNS SETOF public.topup_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;
  RETURN QUERY
    SELECT t.*
    FROM public.topup_requests t
    WHERE p_status IS NULL OR t.status = p_status
    ORDER BY t.created_at DESC;
END;
$function$;

-- The original sections policy checked role directly and bypassed the PIN.
DROP POLICY IF EXISTS sections_admin ON public.site_sections;
CREATE POLICY sections_admin ON public.site_sections
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

NOTIFY pgrst, 'reload schema';
COMMIT;
