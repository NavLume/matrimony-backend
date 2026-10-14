-- Corrects migration 027's erase function: its result columns clashed with column names inside it
-- (PostgreSQL error 42702). Only databases that ran the first version of 027 have the old one.

SET LOCAL search_path = matrimony, public;

DROP FUNCTION IF EXISTS erase_due_members(uuid, timestamptz, integer);

CREATE FUNCTION erase_due_members(p_agency uuid, p_before timestamptz, p_limit integer)
RETURNS TABLE (erased_account_id uuid, erased_storage_key text) LANGUAGE plpgsql SECURITY DEFINER
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

REVOKE ALL ON FUNCTION erase_due_members(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_due_members(uuid, timestamptz, integer) TO matrimony_runtime;
