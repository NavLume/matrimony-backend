-- A concern recorded for a client with no login (21 October 2026).
--
-- A client who has no login cannot tell the platform a worry, so an admin (about anything) or the client's own
-- agent (about another member's profile only) records it for them after they phoned or visited. Such a concern
-- has no reporter account: it names the client it was recorded for, who recorded it, and how it was told.

ALTER TABLE matrimony.concern_reports
    ALTER COLUMN reporter_account_id DROP NOT NULL,
    ADD COLUMN for_profile_id uuid,
    ADD COLUMN recorded_by uuid,
    ADD COLUMN told_by text CHECK (told_by IS NULL OR told_by IN ('phone', 'visit', 'family', 'other')),
    ADD FOREIGN KEY (agency_id, for_profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    ADD FOREIGN KEY (agency_id, recorded_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CONSTRAINT concern_reports_one_reporter CHECK ((reporter_account_id IS NOT NULL) <> (for_profile_id IS NOT NULL)),
    ADD CONSTRAINT concern_reports_recorded_together CHECK (
        (for_profile_id IS NULL) = (recorded_by IS NULL) AND (for_profile_id IS NULL) = (told_by IS NULL)),
    ADD CONSTRAINT concern_reports_recorded_not_shared CHECK (for_profile_id IS NULL OR NOT share_with_agent);
