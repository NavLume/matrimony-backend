-- The terms of a client's service (21 October 2026).
--
-- Disputes in matchmaking turn on what was promised. For each client the agency records, in writing, what the
-- fee covers, how many introductions are promised (if any) and the refund rule, and the client confirms them
-- (in the app when they sign in, or the agent records that they agreed in the office). Every change is a new
-- version; a version is never edited or deleted, only its confirmation can be filled in once.

CREATE TABLE matrimony.client_service_terms (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    profile_id uuid NOT NULL,
    version integer NOT NULL CHECK (version >= 1),
    coverage text NOT NULL CHECK (char_length(coverage) BETWEEN 3 AND 2000),
    introductions integer CHECK (introductions IS NULL OR introductions BETWEEN 1 AND 1000),
    refund_rule text NOT NULL CHECK (char_length(refund_rule) BETWEEN 3 AND 1000),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz,
    acknowledged_by uuid,
    acknowledged_how text CHECK (acknowledged_how IS NULL OR acknowledged_how IN ('client', 'office')),
    PRIMARY KEY (agency_id, profile_id, version),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, acknowledged_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)
       AND (acknowledged_at IS NULL) = (acknowledged_how IS NULL))
);

ALTER TABLE matrimony.client_service_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_service_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_service_terms
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.client_service_terms TO matrimony_runtime;
-- Only the confirmation can be filled in, once (the service checks it is still empty).
GRANT UPDATE (acknowledged_at, acknowledged_by, acknowledged_how) ON matrimony.client_service_terms TO matrimony_runtime;
