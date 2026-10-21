-- Removing a success story's names and words (decided with the owner on 21 October 2026).
--
-- A success story stays on the website when the couple's profiles are erased: its names and words are a separate
-- copy the couple agreed to publish, and stories are what sells the agency. Nobody can tick a box to remove one.
-- A person who wants theirs gone asks the agency, and only an admin can remove it. Removing deletes the names and
-- the words (hiding keeps them), clears the couple's consents so it can never be published again, and keeps who
-- removed it, when and why.
ALTER TABLE matrimony.success_stories
    ADD COLUMN removed_at timestamptz,
    ADD COLUMN removed_by uuid,
    ADD COLUMN removed_reason text CHECK (removed_reason IS NULL OR char_length(removed_reason) BETWEEN 5 AND 300),
    ADD FOREIGN KEY (agency_id, removed_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CONSTRAINT success_stories_removed_together CHECK (
        (removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL) = (removed_reason IS NULL)),
    ADD CONSTRAINT success_stories_removed_is_empty CHECK (
        removed_at IS NULL OR (status = 'hidden' AND story IS NULL AND names = '{}'::jsonb));

GRANT UPDATE (removed_at, removed_by, removed_reason) ON matrimony.success_stories TO matrimony_runtime;
