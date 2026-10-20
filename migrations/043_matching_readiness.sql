-- Ready for matching (20 October 2026).
--
-- Staff may find and release candidates for a client only when the client's agreed registration amount is
-- recorded and the identity document is verified (either may come first). An admin can let a client
-- through anyway, with a reason; the override is kept on the profile and in the event log. Clients that
-- already existed when the rule began are let through with a note saying so.

ALTER TABLE matrimony.member_profiles
    ADD COLUMN matching_override_at timestamptz,
    ADD COLUMN matching_override_by uuid,
    ADD COLUMN matching_override_reason text
        CHECK (matching_override_reason IS NULL OR char_length(matching_override_reason) BETWEEN 3 AND 300),
    ADD FOREIGN KEY (agency_id, matching_override_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CHECK ((matching_override_at IS NULL) = (matching_override_reason IS NULL));

GRANT UPDATE (matching_override_at, matching_override_by, matching_override_reason)
    ON matrimony.member_profiles TO matrimony_runtime;

UPDATE matrimony.member_profiles
   SET matching_override_at = now(),
       matching_override_reason = 'Existing client when the rule began'
 WHERE status IN ('active', 'paused', 'matched');
