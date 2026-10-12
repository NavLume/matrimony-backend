-- Corrects the status guard of migration 023: a superuser counts as a member of every role in
-- PostgreSQL, so the owner and operator tools were refused as well. Only an ordinary session that
-- has been granted the runtime role is held to the rule.
CREATE OR REPLACE FUNCTION matrimony.guard_account_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.role NOT IN ('admin', 'agent')
     AND pg_has_role(session_user, 'matrimony_runtime', 'USAGE')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN
    RAISE EXCEPTION 'only a staff account can be turned off or on'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
