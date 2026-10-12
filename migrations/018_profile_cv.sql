-- A CV (one PDF) per profile (slice 3.J, decided with the friend on 12 October 2026).
--
-- A profile has at most one CV that others may see (`published`) and at most one replacement waiting
-- for a reviewer (`pending`) or turned down (`rejected`). A member's upload waits; staff uploading for
-- an assisted client publish at once. Replacing never leaves a gap: the old CV stays published until
-- the new one is approved. A removed CV keeps its row, and its file is deleted from storage.
--
-- The runtime role may add rows and move them along, never delete: what was uploaded stays on record.
CREATE TABLE matrimony.profile_cvs (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    storage_key text NOT NULL,
    -- The name the file had, for showing and for the download. Never used to find the file.
    file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
    mime_type text NOT NULL DEFAULT 'application/pdf' CHECK (mime_type = 'application/pdf'),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
    status text NOT NULL CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
    uploaded_by_account_id uuid NOT NULL,
    reviewed_by_account_id uuid,
    reviewed_at timestamptz,
    reviewer_notes text CHECK (reviewer_notes IS NULL OR char_length(reviewer_notes) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, storage_key),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, uploaded_by_account_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, reviewed_by_account_id) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (storage_key LIKE agency_id::text || '/' || profile_id::text || '/%'),
    CHECK (status <> 'rejected' OR (reviewed_by_account_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

-- One CV others may see, and one waiting or turned down, per profile.
CREATE UNIQUE INDEX one_published_cv ON matrimony.profile_cvs (agency_id, profile_id)
    WHERE status = 'published';
CREATE UNIQUE INDEX one_replacement_cv ON matrimony.profile_cvs (agency_id, profile_id)
    WHERE status IN ('pending', 'rejected');

ALTER TABLE matrimony.profile_cvs ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.profile_cvs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.profile_cvs
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.profile_cvs TO matrimony_runtime;
GRANT UPDATE (status, reviewed_by_account_id, reviewed_at, reviewer_notes)
    ON matrimony.profile_cvs TO matrimony_runtime;
