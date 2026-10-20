-- A match can be undone (decided with the owner on 20 October 2026: anything can happen after a match).
-- The record is never deleted: it is marked undone, with who did it and why. The same two clients can be
-- matched again later, so only a match that is still standing is unique for a connection.
ALTER TABLE matrimony.couple_matches
    ADD COLUMN undone_at timestamptz,
    ADD COLUMN undone_by uuid,
    ADD COLUMN undo_reason text CHECK (undo_reason IS NULL OR char_length(undo_reason) BETWEEN 3 AND 500),
    ADD CONSTRAINT couple_matches_undo_complete CHECK ((undone_at IS NULL) = (undone_by IS NULL) AND (undone_at IS NULL) = (undo_reason IS NULL)),
    ADD FOREIGN KEY (agency_id, undone_by) REFERENCES matrimony.accounts(agency_id, id);

ALTER TABLE matrimony.couple_matches DROP CONSTRAINT couple_matches_agency_id_interest_id_key;
CREATE UNIQUE INDEX couple_matches_standing ON matrimony.couple_matches (agency_id, interest_id) WHERE undone_at IS NULL;

GRANT UPDATE (undone_at, undone_by, undo_reason) ON matrimony.couple_matches TO matrimony_runtime;
