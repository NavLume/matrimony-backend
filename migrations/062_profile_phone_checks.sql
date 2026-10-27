-- The mobile number asked for at registration (28 October 2026).
--
-- Registering asks for a mobile number but never sends a code for it (it would cost the agency money before anyone has
-- spoken to the person). The agent's first call is the check. This table records "the agent reached this number": it holds
-- the number that was confirmed, so a changed number counts as not confirmed again without anything to reset. A number
-- that a text-message code already proved (registering by phone) needs no row: that is read from the account.
CREATE TABLE matrimony.profile_phone_checks (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    profile_id uuid NOT NULL,
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    confirmed_by uuid NOT NULL,
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, confirmed_by) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.profile_phone_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.profile_phone_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.profile_phone_checks
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.profile_phone_checks TO matrimony_runtime;
GRANT UPDATE (phone_e164, confirmed_by, confirmed_at) ON matrimony.profile_phone_checks TO matrimony_runtime;
