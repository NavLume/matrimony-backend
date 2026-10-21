-- Erasing a person's data, made complete (21 October 2026).
--
-- Migration 027 erased a member's profile, contacts, photos, CV and sign-in details. Many tables were added
-- after it that also hold personal words or files: identity documents, guardians, staff notes and follow-ups,
-- meeting notes and feedback, requests' notes, the private notes on a couple. This puts
-- all of them in one function that erases ONE profile's data, `erase_profile_data`, used by:
--   - the member's own deletion (after the 14 days), through `erase_due_members`, once for each profile they own;
--   - an admin erasing a client who has no login and so cannot ask for it themselves: it is scheduled with a
--     reason, the profile is hidden, and after 7 days an hourly job erases it unless an admin cancels it.
--
-- Deliberately kept (they are records of what the agency did, or the agency's duty to keep): the member code and
-- dates, who approved what, that a request or meeting happened, a published success story (its names and words are
-- a separate copy the couple agreed to), payments (amounts, dates, method, invoice
-- files), what a person agreed to (consent_events), and safety concerns with their outcome. A retention period
-- for the money and safety records is a question for the agency.
--
-- The functions run with the owner's rights because the runtime role can never delete.

SET LOCAL search_path = matrimony, public;

-- When a profile was erased, and (for a client with no login) the scheduled erasure with why and by whom.
-- The reason and who asked are kept after the erasure: they are the agency's record, not the person's data.
ALTER TABLE member_profiles
    ADD COLUMN erased_at timestamptz,
    ADD COLUMN erasure_scheduled_at timestamptz,
    ADD COLUMN erasure_reason text CHECK (erasure_reason IS NULL OR char_length(erasure_reason) BETWEEN 5 AND 300),
    ADD COLUMN erasure_requested_by uuid,
    ADD FOREIGN KEY (agency_id, erasure_requested_by) REFERENCES accounts(agency_id, id),
    ADD CONSTRAINT erasure_scheduled_together CHECK (
        (erasure_scheduled_at IS NULL) = (erasure_reason IS NULL)
        AND (erasure_scheduled_at IS NULL) = (erasure_requested_by IS NULL));
GRANT SELECT (erased_at, erasure_scheduled_at, erasure_reason, erasure_requested_by) ON member_profiles TO matrimony_runtime;

-- Where a returned file lives: 'photo' has size variants, 'file' is one object.
DROP FUNCTION IF EXISTS erase_due_members(uuid, timestamptz, integer);

CREATE FUNCTION erase_profile_data(p_agency uuid, p_profile uuid)
RETURNS TABLE (file_key text, file_kind text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = matrimony, public AS $$
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;

  -- The files, to be deleted from storage by the caller.
  RETURN QUERY SELECT ph.storage_key, 'photo'::text FROM profile_photos ph
                WHERE ph.agency_id = p_agency AND ph.profile_id = p_profile AND ph.status <> 'removed';
  RETURN QUERY SELECT cv.storage_key, 'file'::text FROM profile_cvs cv
                WHERE cv.agency_id = p_agency AND cv.profile_id = p_profile AND cv.status <> 'removed';
  RETURN QUERY SELECT v.file_key, 'file'::text FROM profile_verifications v
                WHERE v.agency_id = p_agency AND v.profile_id = p_profile AND v.file_removed_at IS NULL;

  UPDATE profile_photos SET status = 'removed', is_primary = false
   WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE profile_cvs SET status = 'removed', file_name = 'removed.pdf', reviewer_notes = NULL
   WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE profile_verifications SET file_removed_at = COALESCE(file_removed_at, now()), decision_note = NULL
   WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE profile_reviews SET proposed_changes = CASE WHEN proposed_changes IS NULL THEN NULL ELSE '{}'::jsonb END,
                             reviewer_notes = NULL
   WHERE agency_id = p_agency AND profile_id = p_profile;
  DELETE FROM profile_contacts WHERE agency_id = p_agency AND profile_id = p_profile;
  DELETE FROM partner_preferences WHERE agency_id = p_agency AND profile_id = p_profile;

  -- Words staff wrote about the person.
  UPDATE client_notes SET body = '[erased]' WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE client_follow_ups SET text = '[erased]' WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE meeting_feedback SET note = NULL WHERE agency_id = p_agency AND profile_id = p_profile;
  UPDATE meetings SET note = NULL, place = NULL
   WHERE agency_id = p_agency AND interest_id IN
         (SELECT id FROM interests WHERE agency_id = p_agency
           AND (sender_profile_id = p_profile OR recipient_profile_id = p_profile));
  UPDATE interests SET note = NULL
   WHERE agency_id = p_agency AND (sender_profile_id = p_profile OR recipient_profile_id = p_profile);
  UPDATE recommendations SET member_feedback = NULL, internal_note = NULL, member_visible_note = NULL
   WHERE agency_id = p_agency AND (source_profile_id = p_profile OR candidate_profile_id = p_profile);
  UPDATE client_payments SET note = NULL WHERE agency_id = p_agency AND profile_id = p_profile;

  -- A couple's private note goes. A success story does NOT: its names and words are a separate copy the couple
  -- agreed to publish, so it stays when a profile is erased. Only an admin removes a story (migration 054).
  -- (an undone match must keep some reason, by a constraint, so its words are replaced, not removed)
  UPDATE couple_matches SET note = NULL, undo_reason = CASE WHEN undo_reason IS NULL THEN NULL ELSE '[erased]' END
   WHERE agency_id = p_agency AND (profile_a = p_profile OR profile_b = p_profile);

  -- Guardians: their name and email go, their access ends.
  UPDATE profile_guardians SET email = 'erased-' || id::text || '@erased.invalid', display_name = 'Removed',
         token_hash = NULL, status = 'removed', removed_at = COALESCE(removed_at, now())
   WHERE agency_id = p_agency AND profile_id = p_profile;
  DELETE FROM account_credentials WHERE agency_id = p_agency AND account_id IN
         (SELECT account_id FROM profile_guardians WHERE agency_id = p_agency AND profile_id = p_profile
            AND account_id IS NOT NULL);
  DELETE FROM account_identities WHERE agency_id = p_agency AND account_id IN
         (SELECT account_id FROM profile_guardians WHERE agency_id = p_agency AND profile_id = p_profile
            AND account_id IS NOT NULL);
  DELETE FROM notifications WHERE agency_id = p_agency AND recipient_account_id IN
         (SELECT account_id FROM profile_guardians WHERE agency_id = p_agency AND profile_id = p_profile
            AND account_id IS NOT NULL);
  UPDATE accounts SET display_name = 'Deleted guardian', email = NULL, email_verified_at = NULL,
         phone_e164 = NULL, phone_verified_at = NULL, auth_issuer = NULL, auth_subject = NULL,
         status = 'disabled', erased_at = now(), updated_at = now()
   WHERE agency_id = p_agency AND role = 'guardian' AND id IN
         (SELECT account_id FROM profile_guardians WHERE agency_id = p_agency AND profile_id = p_profile
            AND account_id IS NOT NULL);

  UPDATE client_logins
     SET email = CASE WHEN channel = 'email' THEN 'erased@erased.invalid' END,
         phone_e164 = CASE WHEN channel = 'sms' THEN '+19999999999' END,
         revoked_at = CASE WHEN accepted_at IS NULL THEN COALESCE(revoked_at, now()) ELSE revoked_at END
   WHERE agency_id = p_agency AND profile_id = p_profile;

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
      erased_at = COALESCE(erased_at, now()), updated_at = now()
   WHERE agency_id = p_agency AND id = p_profile;
END;
$$;

-- A member's own deletion, once the 14 days are over: every profile they own, then their account.
CREATE FUNCTION erase_due_members(p_agency uuid, p_before timestamptz, p_limit integer)
RETURNS TABLE (erased_account_id uuid, erased_file_key text, erased_file_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE a record; p record;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  FOR a IN
    SELECT id FROM accounts
     WHERE agency_id = p_agency AND role = 'member' AND erased_at IS NULL
       AND deletion_requested_at IS NOT NULL AND deletion_requested_at <= p_before
     ORDER BY deletion_requested_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    -- An account with no files still has to be reported as erased, so one row always comes back.
    erased_account_id := a.id; erased_file_key := NULL; erased_file_kind := NULL;
    RETURN NEXT;
    FOR p IN SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = a.id
    LOOP
      RETURN QUERY SELECT a.id, e.file_key, e.file_kind FROM erase_profile_data(p_agency, p.id) e;
    END LOOP;
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

-- A client who has no login cannot ask to be erased, so an administrator asks for them (the caller checks the
-- role). Only a profile that is assisted and has no owning account. The profile is hidden at once and kept so it
-- can come back; an administrator can cancel within 7 days; after that the hourly job erases it.
CREATE FUNCTION schedule_client_erasure(p_agency uuid, p_profile uuid, p_actor uuid, p_reason text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE scheduled timestamptz;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE member_profiles
     SET erasure_scheduled_at = now(), erasure_reason = p_reason, erasure_requested_by = p_actor,
         status_before_deletion = COALESCE(status_before_deletion, status), status = 'closed',
         updated_at = now()
   WHERE agency_id = p_agency AND id = p_profile AND service_mode = 'assisted'
     AND owner_account_id IS NULL AND erased_at IS NULL AND erasure_scheduled_at IS NULL
  RETURNING erasure_scheduled_at INTO scheduled;
  IF scheduled IS NULL THEN RETURN NULL; END IF;
  -- Open requests to and from this person are withdrawn, as in a member's own deletion.
  UPDATE interests SET status = 'withdrawn', updated_at = now()
   WHERE agency_id = p_agency AND status IN ('pending', 'in_review')
     AND (sender_profile_id = p_profile OR recipient_profile_id = p_profile);
  RETURN scheduled;
END;
$$;

CREATE FUNCTION cancel_client_erasure(p_agency uuid, p_profile uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE cancelled boolean;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE member_profiles
     SET erasure_scheduled_at = NULL, erasure_reason = NULL, erasure_requested_by = NULL,
         status = COALESCE(status_before_deletion, status), status_before_deletion = NULL, updated_at = now()
   WHERE agency_id = p_agency AND id = p_profile AND erasure_scheduled_at IS NOT NULL AND erased_at IS NULL
  RETURNING true INTO cancelled;
  RETURN cancelled IS NOT NULL;
END;
$$;

-- The hourly job: erases the clients whose 7 days are over. One row with no file is returned for each profile
-- erased, so the caller can record it even when it had no files.
CREATE FUNCTION erase_due_clients(p_agency uuid, p_before timestamptz, p_limit integer)
RETURNS TABLE (erased_profile_id uuid, erased_file_key text, erased_file_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE c record;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  FOR c IN
    SELECT id FROM member_profiles
     WHERE agency_id = p_agency AND service_mode = 'assisted' AND owner_account_id IS NULL
       AND erased_at IS NULL AND erasure_scheduled_at IS NOT NULL AND erasure_scheduled_at <= p_before
     ORDER BY erasure_scheduled_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  LOOP
    erased_profile_id := c.id; erased_file_key := NULL; erased_file_kind := NULL;
    RETURN NEXT;
    RETURN QUERY SELECT c.id, e.file_key, e.file_kind FROM erase_profile_data(p_agency, c.id) e;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION erase_profile_data(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_due_members(uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION schedule_client_erasure(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_client_erasure(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_due_clients(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_due_members(uuid, timestamptz, integer) TO matrimony_runtime;
GRANT EXECUTE ON FUNCTION schedule_client_erasure(uuid, uuid, uuid, text) TO matrimony_runtime;
GRANT EXECUTE ON FUNCTION cancel_client_erasure(uuid, uuid) TO matrimony_runtime;
GRANT EXECUTE ON FUNCTION erase_due_clients(uuid, timestamptz, integer) TO matrimony_runtime;
