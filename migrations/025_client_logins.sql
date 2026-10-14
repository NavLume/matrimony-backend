-- A login for a client who has none (14 October 2026).
--
-- An agent (or an admin) sends a one-time link, by text message or email, to a client the agency runs.
-- The client opens it, chooses their own password and accepts the terms; an account is then created
-- and attached to their existing profile. The agent never sees the password. The profile stays
-- 'assisted', so the agent keeps the control they had.
--
-- Only a hash of the link's secret is stored. One open link per profile: sending again replaces it.

CREATE TABLE matrimony.client_logins (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('sms', 'email')),
    email text CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> '')),
    phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    locale text NOT NULL CHECK (locale IN ('bn', 'en')),
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    accepted_account_id uuid,
    revoked_at timestamptz,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, accepted_account_id) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (
        (channel = 'email' AND email IS NOT NULL AND phone_e164 IS NULL)
        OR (channel = 'sms' AND phone_e164 IS NOT NULL AND email IS NULL)
    ),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL),
    CHECK ((accepted_at IS NULL) = (accepted_account_id IS NULL))
);

CREATE UNIQUE INDEX client_logins_token_hash ON matrimony.client_logins (token_hash);
CREATE UNIQUE INDEX client_logins_one_open_per_profile
    ON matrimony.client_logins (agency_id, profile_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE matrimony.client_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_logins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_logins
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.client_logins TO matrimony_runtime;
GRANT UPDATE (channel, email, phone_e164, locale, token_hash, expires_at, created_by, created_at,
              accepted_at, accepted_account_id, revoked_at)
    ON matrimony.client_logins TO matrimony_runtime;
