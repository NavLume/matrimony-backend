-- Fraud signals (22 October 2026): warning flags for staff, never for the member, and never an automatic block.
--
-- The flags themselves are not stored: they are read from what the platform already holds (the same phone number or
-- email on several profiles, the same photo, a burst of requests, several reports about one profile, an identity
-- document rejected twice), so they are always current. Two things are stored:
--   profile_photos.content_hash   a fingerprint of the processed photo, taken when it is uploaded, so the same
--                                 picture on two profiles can be noticed. Photos from before this have none (a script
--                                 fills them in); only exact copies match, not a cropped or edited one.
--   fraud_flag_reviews            what a staff member decided about one flag on one profile: checked and fine, or
--                                 confirmed as a problem. A flag comes back only if new evidence appears after it.
ALTER TABLE matrimony.profile_photos
    ADD COLUMN content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX profile_photos_content_hash ON matrimony.profile_photos (agency_id, content_hash)
    WHERE content_hash IS NOT NULL AND status <> 'removed';
GRANT UPDATE (content_hash) ON matrimony.profile_photos TO matrimony_runtime;

CREATE TABLE matrimony.fraud_flag_reviews (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    profile_id uuid NOT NULL,
    signal text NOT NULL CHECK (signal IN (
        'shared_phone', 'shared_email', 'shared_photo', 'request_burst', 'reported_by_several', 'document_rejected_twice')),
    outcome text NOT NULL CHECK (outcome IN ('fine', 'confirmed')),
    reviewed_by uuid NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id, signal),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, reviewed_by) REFERENCES matrimony.accounts(agency_id, id)
);
ALTER TABLE matrimony.fraud_flag_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.fraud_flag_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.fraud_flag_reviews
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT, INSERT ON matrimony.fraud_flag_reviews TO matrimony_runtime;
GRANT UPDATE (outcome, reviewed_by, reviewed_at) ON matrimony.fraud_flag_reviews TO matrimony_runtime;
