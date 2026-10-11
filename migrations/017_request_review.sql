-- The agent reviews a request before it reaches the person asked (slice 3.H, decided with the friend
-- on 12 October 2026, docs/features/discovery-loop.md).
--
-- A request now starts as `in_review`: it waits for the agent who looks after the person asked (or
-- an admin when nobody does). Approving moves it to `pending`, which is what the request always was
-- until now; rejecting ends it as `declined`, so the asker is told it was declined. A declined pair
-- can be reopened by staff, which returns it to `withdrawn`, the state that can be asked again.
--
-- It also holds a short note a member may add when asking, and what the reminders need.

-- The status check and the "answered" check both list the statuses, so both are replaced. They are
-- found by what they say rather than by an assumed generated name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'matrimony.interests'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%withdrawn%'
  LOOP
    EXECUTE format('ALTER TABLE matrimony.interests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE matrimony.interests
    ADD CONSTRAINT interests_status_check
    CHECK (status IN ('in_review', 'pending', 'accepted', 'declined', 'withdrawn'));

ALTER TABLE matrimony.interests
    ADD CONSTRAINT interests_answered_check
    CHECK ((status IN ('accepted', 'declined') AND responded_at IS NOT NULL AND responded_by_account_id IS NOT NULL)
        OR status IN ('in_review', 'pending', 'withdrawn'));

ALTER TABLE matrimony.interests
    ADD COLUMN note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
    ADD COLUMN reviewed_by_account_id uuid,
    ADD COLUMN reviewed_at timestamptz,
    -- When the request started waiting for review: reminders count from here.
    ADD COLUMN review_started_at timestamptz,
    ADD COLUMN reminders_sent integer NOT NULL DEFAULT 0 CHECK (reminders_sent >= 0),
    ADD COLUMN last_reminded_at timestamptz,
    ADD CONSTRAINT interests_reviewer_fk
        FOREIGN KEY (agency_id, reviewed_by_account_id) REFERENCES matrimony.accounts(agency_id, id);

-- The queue of requests waiting for review, and the reminder job, read only these rows.
CREATE INDEX interests_in_review ON matrimony.interests (agency_id, review_started_at)
    WHERE status = 'in_review';

GRANT UPDATE (note, reviewed_by_account_id, reviewed_at, review_started_at, reminders_sent,
              last_reminded_at)
    ON matrimony.interests TO matrimony_runtime;
