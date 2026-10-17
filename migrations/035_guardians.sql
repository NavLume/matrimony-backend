-- A guardian for a client (17 October 2026).
--
-- A client's parent or relative may be given a login of their own to see the client's proposals and
-- give advice. Decided with the owner:
--   * one guardian per profile, invited by email by the agent who looks after the client;
--   * the client must agree first: a client who signs in agrees in the app, and for a client with no
--     login the agent records that the client agreed (who and when are kept);
--   * a guardian only advises. Accepting or declining stays with the client (or their agent);
--   * a guardian sees the same details about other people as the client does, and nothing else:
--     no chat, no payments, no editing, no contact sharing.
-- A guardian is a separate kind of account ('guardian') linked to exactly one profile.
--
-- profile_guardians holds the whole story of one guardian: asked for, agreed to, invited, active,
-- removed. Only a hash of the invitation link is stored. The runtime role may add rows and move one
-- along; it may not delete one, so who was a guardian, and who agreed, stays on record.

ALTER TABLE matrimony.accounts DROP CONSTRAINT accounts_role_check;
ALTER TABLE matrimony.accounts ADD CONSTRAINT accounts_role_check
    CHECK (role IN ('admin', 'agent', 'member', 'guardian'));

CREATE TABLE matrimony.profile_guardians (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    locale text NOT NULL CHECK (locale IN ('bn', 'en')),
    -- awaiting_client: a client who signs in has not agreed yet. invited: the link was sent.
    -- active: the guardian has an account. removed: ended by the client or the agency.
    status text NOT NULL CHECK (status IN ('awaiting_client', 'invited', 'active', 'removed')),
    -- How the client's agreement was given, and who gave it (the client, or the agent who recorded it).
    consent_basis text CHECK (consent_basis IN ('client_in_app', 'agent_recorded')),
    consented_at timestamptz,
    consented_by uuid,
    token_hash text,
    expires_at timestamptz,
    invited_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    account_id uuid,
    accepted_at timestamptz,
    removed_at timestamptz,
    removed_by uuid,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, invited_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, consented_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, removed_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (status = 'awaiting_client' OR (consent_basis IS NOT NULL AND consented_at IS NOT NULL AND consented_by IS NOT NULL)),
    CHECK ((status = 'active') = (account_id IS NOT NULL AND accepted_at IS NOT NULL AND removed_at IS NULL)
        OR status = 'removed'),
    CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);
-- One guardian per profile at a time.
CREATE UNIQUE INDEX profile_guardians_one_per_profile
    ON matrimony.profile_guardians (agency_id, profile_id) WHERE status <> 'removed';
-- A guardian account looks after one profile.
CREATE UNIQUE INDEX profile_guardians_one_per_account
    ON matrimony.profile_guardians (agency_id, account_id) WHERE status <> 'removed' AND account_id IS NOT NULL;
CREATE UNIQUE INDEX profile_guardians_token_hash
    ON matrimony.profile_guardians (token_hash) WHERE token_hash IS NOT NULL;

ALTER TABLE matrimony.profile_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.profile_guardians FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.profile_guardians
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.profile_guardians TO matrimony_runtime;
GRANT UPDATE (display_name, locale, status, consent_basis, consented_at, consented_by, token_hash,
              expires_at, invited_by, account_id, accepted_at, removed_at, removed_by)
    ON matrimony.profile_guardians TO matrimony_runtime;

-- What a guardian advised about a proposal the client received. One line per proposal; advising again
-- replaces it. The client, their agent and the guardian read it.
CREATE TABLE matrimony.guardian_advice (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    interest_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    advice text NOT NULL CHECK (advice IN ('supportive', 'concerned')),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
    advised_by uuid NOT NULL,
    advised_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, interest_id, profile_id),
    FOREIGN KEY (agency_id, interest_id) REFERENCES matrimony.interests(agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, advised_by) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.guardian_advice ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.guardian_advice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.guardian_advice
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.guardian_advice TO matrimony_runtime;
GRANT UPDATE (advice, note, advised_by, advised_at) ON matrimony.guardian_advice TO matrimony_runtime;
