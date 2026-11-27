-- Success stories added by hand (27 November 2026).
--
-- The agency has more than twelve years of real couples from before the website. An admin may add their stories
-- directly, without a match on the platform, in the same table, so the public site, the photo pipeline, hiding and
-- removal work for them unchanged.
--
--   source 'match'   written at the matched step; published only after both clients agreed (consent_a_at, consent_b_at)
--   source 'manual'  added by an admin; published only after the admin recorded that the couple gave permission,
--                    with a short note of how and when (consent_recorded_at, consent_recorded_by, consent_note)
--
-- Every existing row is a match story and keeps its match. Additive: no row is changed.

ALTER TABLE matrimony.success_stories
    ALTER COLUMN match_id DROP NOT NULL,
    ADD COLUMN source text NOT NULL DEFAULT 'match' CHECK (source IN ('match', 'manual')),
    ADD COLUMN consent_recorded_at timestamptz,
    ADD COLUMN consent_recorded_by uuid,
    ADD COLUMN consent_note text CHECK (consent_note IS NULL OR char_length(consent_note) BETWEEN 5 AND 300),
    ADD FOREIGN KEY (agency_id, consent_recorded_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CONSTRAINT success_stories_source_match CHECK (
        (source = 'match' AND match_id IS NOT NULL) OR (source = 'manual' AND match_id IS NULL)),
    -- Each source has its own kind of consent, never the other's.
    ADD CONSTRAINT success_stories_consent_kind CHECK (
        (source = 'match' AND consent_recorded_at IS NULL)
        OR (source = 'manual' AND consent_a_at IS NULL AND consent_b_at IS NULL AND consent_by IS NULL)),
    ADD CONSTRAINT success_stories_consent_recorded_together CHECK (
        (consent_recorded_at IS NULL) = (consent_recorded_by IS NULL)
        AND (consent_recorded_at IS NULL) = (consent_note IS NULL)),
    -- A removed story keeps no permission and no note (the note may name the couple), so it can never come back.
    ADD CONSTRAINT success_stories_removed_has_no_consent CHECK (
        removed_at IS NULL OR consent_recorded_at IS NULL);

-- The rule "published needs consent" now depends on the source. The old check (created unnamed in 038) is replaced.
ALTER TABLE matrimony.success_stories DROP CONSTRAINT success_stories_check;
ALTER TABLE matrimony.success_stories ADD CONSTRAINT success_stories_published_has_consent CHECK (
    status <> 'published'
    OR (source = 'match' AND consent_a_at IS NOT NULL AND consent_b_at IS NOT NULL)
    OR (source = 'manual' AND consent_recorded_at IS NOT NULL));

-- The admin's list of every story, newest first.
CREATE INDEX success_stories_recent ON matrimony.success_stories (agency_id, created_at DESC, id DESC);

-- INSERT is granted on the whole table (038), so the new columns can be written on insert. source and match_id are
-- never changed after that.
GRANT UPDATE (consent_recorded_at, consent_recorded_by, consent_note) ON matrimony.success_stories TO matrimony_runtime;
