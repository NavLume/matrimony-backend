-- A member deleting their own account (14 October 2026).
--
-- Decided with the owner: deleting hides the profile and signs the person out at once, the person has
-- 14 days to change their mind (signing in again cancels it), and after that everything personal is
-- erased. The agency keeps a bare history with no personal details: the member code, dates, status
-- history, who approved what, and that connections happened. Apple and Google require this to be
-- possible from inside an app.
--
-- The runtime role is deliberately never granted DELETE, and it may update only a few columns of an
-- account. So the work is done by functions that run with the owner's rights. Each one checks the
-- agency (row-level security still applies, through the transaction's agency setting) and that the
-- account is a member's, so they cannot be used on staff or on another agency.

SET LOCAL search_path = matrimony, public;

ALTER TABLE accounts
    ADD COLUMN deletion_requested_at timestamptz,
    ADD COLUMN erased_at timestamptz;

ALTER TABLE member_profiles
    ADD COLUMN status_before_deletion text;

-- An erased account has neither a phone number nor an email any more.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'matrimony.accounts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%phone_e164 IS NOT NULL%email IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE matrimony.accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_has_contact_unless_erased
    CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR erased_at IS NOT NULL);

-- A member's account may only be turned off or on by staff (migration 023, 024). The erasing function
-- turns the account off, and runs as its owner, which is the one case to let through: inside it the
-- current user is not the session user.
CREATE OR REPLACE FUNCTION guard_account_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.role NOT IN ('admin', 'agent')
     AND current_user = session_user
     AND pg_has_role(session_user, 'matrimony_runtime', 'USAGE')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper) THEN
    RAISE EXCEPTION 'only a staff account can be turned off or on'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Step 1: the member asks. The profile is hidden (closed) and remembered so it can come back.
CREATE FUNCTION request_member_deletion(p_agency uuid, p_account uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE requested timestamptz;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE accounts SET deletion_requested_at = COALESCE(deletion_requested_at, now())
   WHERE agency_id = p_agency AND id = p_account AND role = 'member' AND status = 'active'
     AND erased_at IS NULL
  RETURNING deletion_requested_at INTO requested;
  IF requested IS NULL THEN RETURN NULL; END IF;
  UPDATE member_profiles
     SET status_before_deletion = COALESCE(status_before_deletion, status), status = 'closed',
         updated_at = now()
   WHERE agency_id = p_agency AND owner_account_id = p_account AND status <> 'closed';
  -- Open requests to and from this person are withdrawn.
  UPDATE interests SET status = 'withdrawn', updated_at = now()
   WHERE agency_id = p_agency AND status = 'pending'
     AND (sender_profile_id IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account)
       OR recipient_profile_id IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account));
  RETURN requested;
END;
$$;

-- Signing in again (or asking to) within the 14 days brings everything back.
CREATE FUNCTION cancel_member_deletion(p_agency uuid, p_account uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE cancelled boolean;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE accounts SET deletion_requested_at = NULL
   WHERE agency_id = p_agency AND id = p_account AND deletion_requested_at IS NOT NULL
     AND erased_at IS NULL
  RETURNING true INTO cancelled;
  IF cancelled IS NULL THEN RETURN false; END IF;
  UPDATE member_profiles
     SET status = status_before_deletion, status_before_deletion = NULL, updated_at = now()
   WHERE agency_id = p_agency AND owner_account_id = p_account AND status_before_deletion IS NOT NULL;
  RETURN true;
END;
$$;

-- Step 2: after the waiting time, erase. Returns the file keys to delete from storage. Rows are kept
-- (other records point at them) but hold no personal data afterwards.
CREATE FUNCTION erase_due_members(p_agency uuid, p_before timestamptz, p_limit integer)
RETURNS TABLE (account_id uuid, storage_key text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = matrimony, public AS $$
DECLARE a record;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  FOR a IN
    SELECT id FROM accounts
     WHERE agency_id = p_agency AND role = 'member' AND erased_at IS NULL
       AND deletion_requested_at IS NOT NULL AND deletion_requested_at <= p_before
     ORDER BY deletion_requested_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    RETURN QUERY
      SELECT a.id, k.storage_key FROM (
        SELECT ph.storage_key FROM profile_photos ph
         WHERE ph.agency_id = p_agency AND ph.profile_id IN
               (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id)
        UNION
        SELECT cv.storage_key FROM profile_cvs cv
         WHERE cv.agency_id = p_agency AND cv.profile_id IN
               (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id)
      ) k;

    UPDATE profile_photos SET status = 'removed', is_primary = false
     WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    UPDATE profile_cvs SET status = 'removed', file_name = 'removed.pdf', reviewer_notes = NULL
     WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    UPDATE profile_reviews SET proposed_changes = CASE WHEN proposed_changes IS NULL THEN NULL ELSE '{}'::jsonb END,
                               reviewer_notes = NULL
     WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    DELETE FROM profile_contacts WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    DELETE FROM partner_preferences WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    UPDATE member_profiles SET
        full_name = 'Deleted member', date_of_birth = NULL, gender = NULL, marital_status = NULL,
        height_cm = NULL, weight_kg = NULL, complexion_code = NULL, blood_group = NULL,
        religion_code = NULL, sect_code = NULL, current_city = NULL, current_district_code = NULL,
        current_division_code = NULL, origin_district_code = NULL, highest_degree_code = NULL,
        institution_name = NULL, field_of_study = NULL, graduation_year = NULL, occupation_code = NULL,
        job_title = NULL, employer_name = NULL, monthly_income_band_code = NULL, father_name = NULL,
        father_occupation = NULL, mother_name = NULL, mother_occupation = NULL, sibling_count = NULL,
        family_status_code = NULL, religious_practice_code = NULL, dietary_preference_code = NULL,
        hobbies = NULL, about_me = NULL, status = 'closed', status_before_deletion = NULL,
        updated_at = now()
     WHERE agency_id = p_agency AND owner_account_id = a.id;
    UPDATE client_logins
       SET email = CASE WHEN channel = 'email' THEN 'erased@erased.invalid' END,
           phone_e164 = CASE WHEN channel = 'sms' THEN '+19999999999' END
     WHERE agency_id = p_agency AND profile_id IN
           (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id);
    DELETE FROM notifications WHERE agency_id = p_agency AND recipient_account_id = a.id;
    DELETE FROM account_credentials WHERE agency_id = p_agency AND account_id = a.id;
    DELETE FROM account_identities WHERE agency_id = p_agency AND account_id = a.id;
    UPDATE accounts SET display_name = 'Deleted member', email = NULL, email_verified_at = NULL,
           phone_e164 = NULL, phone_verified_at = NULL, auth_issuer = NULL, auth_subject = NULL,
           status = 'disabled', erased_at = now(), updated_at = now()
     WHERE agency_id = p_agency AND id = a.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION request_member_deletion(uuid, uuid), cancel_member_deletion(uuid, uuid),
    erase_due_members(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_member_deletion(uuid, uuid), cancel_member_deletion(uuid, uuid),
    erase_due_members(uuid, timestamptz, integer) TO matrimony_runtime;
