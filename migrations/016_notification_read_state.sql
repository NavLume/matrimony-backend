-- Read and unread state for the inbox (slice 3.G, docs/features/discovery-loop.md).
--
-- A notification was only ever added and read. The unread count and "mark as read" need one more
-- fact: when the recipient read it. The runtime role may change that column and nothing else, so
-- what a notification says can never be rewritten, and it still cannot delete a row.

ALTER TABLE matrimony.notifications ADD COLUMN read_at timestamptz;

GRANT UPDATE (read_at) ON matrimony.notifications TO matrimony_runtime;

-- The unread count of one account, without reading the whole inbox.
CREATE INDEX notifications_unread ON matrimony.notifications (agency_id, recipient_account_id)
    WHERE read_at IS NULL;
