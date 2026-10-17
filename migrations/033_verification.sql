-- Identity verification (17 October 2026).
--
-- A client (or the agent for an assisted client) sends one identity document: a national ID, passport,
-- birth certificate or driving licence, as a PDF, JPG or PNG up to 5 MB. Staff who look after the client
-- compare it with the profile and approve or reject it. An approved profile carries a "Verified" mark
-- that other members see. The document is private and is deleted from storage as soon as it is decided,
-- so the platform keeps the fact of the check, never the document. The runtime role may add a request
-- and decide it, nothing else.

ALTER TABLE matrimony.member_profiles
    ADD COLUMN verified_at timestamptz,
    ADD COLUMN verified_by uuid,
    ADD FOREIGN KEY (agency_id, verified_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CHECK ((verified_at IS NULL) = (verified_by IS NULL));

CREATE TABLE matrimony.profile_verifications (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    doc_type text NOT NULL CHECK (doc_type IN ('nid', 'passport', 'birth_certificate', 'driving_license')),
    file_key text NOT NULL,
    file_mime text NOT NULL CHECK (file_mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    file_size integer NOT NULL CHECK (file_size BETWEEN 1 AND 5242880),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    submitted_by uuid NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid,
    decided_at timestamptz,
    decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 3 AND 300),
    -- When the file was removed from storage (at the decision).
    file_removed_at timestamptz,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, submitted_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, decided_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One request waits at a time for a profile.
CREATE UNIQUE INDEX profile_verifications_one_pending ON matrimony.profile_verifications (agency_id, profile_id)
    WHERE status = 'pending';
CREATE INDEX profile_verifications_by_profile ON matrimony.profile_verifications (agency_id, profile_id, submitted_at DESC);
CREATE INDEX profile_verifications_waiting ON matrimony.profile_verifications (agency_id, submitted_at)
    WHERE status = 'pending';

ALTER TABLE matrimony.profile_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.profile_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.profile_verifications
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.profile_verifications TO matrimony_runtime;
GRANT UPDATE (status, decided_by, decided_at, decision_note, file_removed_at)
    ON matrimony.profile_verifications TO matrimony_runtime;
