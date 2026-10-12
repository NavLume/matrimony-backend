-- The application may turn a staff account off and on (migration 019), and only a staff account.
--
-- The column grant lets the runtime role write `status` of any account. This makes the database
-- refuse it for a member, so a mistake in the application can never switch a member off through
-- that grant. An operator working as the owner is not affected.
CREATE FUNCTION matrimony.guard_account_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.role NOT IN ('admin', 'agent')
     AND pg_has_role(session_user, 'matrimony_runtime', 'USAGE') THEN
    RAISE EXCEPTION 'only a staff account can be turned off or on'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_guard_status BEFORE UPDATE OF status ON matrimony.accounts
    FOR EACH ROW EXECUTE FUNCTION matrimony.guard_account_status();
