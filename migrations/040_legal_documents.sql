-- The agency's own terms of service and privacy policy (20 October 2026). Each save is a new, numbered
-- version that is never changed or removed, so a consent that names a version can always be traced to
-- the exact text that was shown. The latest version is the current one. A version with no text means
-- "use the platform's draft".
CREATE TABLE matrimony.legal_documents (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    kind text NOT NULL CHECK (kind IN ('terms', 'privacy')),
    version integer NOT NULL CHECK (version >= 1),
    -- Bengali and English, either may be missing.
    title jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(title) = 'object'),
    body jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(body) = 'object'),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, kind, version),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id)
);

ALTER TABLE matrimony.legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.legal_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.legal_documents
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.legal_documents TO matrimony_runtime;
