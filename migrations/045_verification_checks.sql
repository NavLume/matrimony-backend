-- What was actually checked (21 October 2026).
--
-- The Verified mark used to mean one thing. A document check proves who a person is and how old, not whether
-- they are married or what they earn, and a badge that sounds like more than was checked is a claim the agency
-- may have to defend. A verified profile now carries the list of checks the staff member made:
--   identity        name and date of birth match an identity document (always, for a verified profile)
--   photo           the photo shown is of this person
--   marital_status  the marital status was checked with a document
-- Everything else (income, education, family) is only what the person said. Each approval records the checks
-- made; an approved profile's optional checks can be changed later with the event log keeping who did it.
-- Also: "divorce pending" is now a marital status of its own.

ALTER TABLE matrimony.member_profiles
    ADD COLUMN verified_checks text[] NOT NULL DEFAULT '{}';

UPDATE matrimony.member_profiles SET verified_checks = ARRAY['identity'] WHERE verified_at IS NOT NULL;

ALTER TABLE matrimony.member_profiles
    ADD CONSTRAINT member_profiles_verified_checks_valid
        CHECK (verified_checks <@ ARRAY['identity', 'photo', 'marital_status']::text[]),
    ADD CONSTRAINT member_profiles_verified_checks_match_mark
        CHECK ((verified_at IS NULL AND cardinality(verified_checks) = 0)
            OR (verified_at IS NOT NULL AND 'identity' = ANY(verified_checks)));

GRANT UPDATE (verified_checks) ON matrimony.member_profiles TO matrimony_runtime;

ALTER TABLE matrimony.profile_verifications
    ADD COLUMN checks text[] NOT NULL DEFAULT '{}';
GRANT UPDATE (checks) ON matrimony.profile_verifications TO matrimony_runtime;

ALTER TABLE matrimony.member_profiles DROP CONSTRAINT member_profiles_marital_status_check;
ALTER TABLE matrimony.member_profiles
    ADD CONSTRAINT member_profiles_marital_status_check
        CHECK (marital_status IN ('never_married', 'divorce_pending', 'divorced', 'widowed'));
