-- Private concerns (21 October 2026).
--
-- A member can tell the agency about a worry without their family seeing it: a profile that looks fake, someone
-- who harasses or asks for money, a photo being misused, a dowry demand, or the conduct of the agency's own
-- staff. Only an admin reads a concern (an agent may be the person it is about), decides what to do, and writes a
-- short outcome the reporter can read. A concern is never edited or deleted; its outcome is filled in once.

CREATE TABLE matrimony.concern_reports (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    reporter_account_id uuid NOT NULL,
    about_kind text NOT NULL CHECK (about_kind IN ('profile', 'agency', 'other')),
    about_profile_id uuid,
    category text NOT NULL CHECK (category IN
        ('fake_profile', 'harassment', 'asks_for_money', 'photo_misuse', 'dowry', 'staff_conduct', 'other')),
    message text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 1500),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_by uuid,
    resolved_at timestamptz,
    outcome_note text CHECK (outcome_note IS NULL OR char_length(outcome_note) BETWEEN 3 AND 500),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, reporter_account_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, about_profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, resolved_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((about_kind = 'profile') = (about_profile_id IS NOT NULL)),
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)
       AND (resolved_at IS NULL) = (resolved_by IS NULL)
       AND (resolved_at IS NULL) = (outcome_note IS NULL))
);
CREATE INDEX concern_reports_by_status ON matrimony.concern_reports (agency_id, status, created_at DESC);
CREATE INDEX concern_reports_by_reporter ON matrimony.concern_reports (agency_id, reporter_account_id, created_at DESC);

ALTER TABLE matrimony.concern_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.concern_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.concern_reports
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.concern_reports TO matrimony_runtime;
GRANT UPDATE (status, resolved_by, resolved_at, outcome_note) ON matrimony.concern_reports TO matrimony_runtime;
