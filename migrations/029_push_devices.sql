-- Push notifications for the mobile app (14 October 2026).
--
-- A phone registers a push token after sign-in. When an inbox line is added, the API sends a short push
-- to that account's phones. The text is generic on purpose (no names, no details), because a lock
-- screen is public: the person opens the app to read the real line.
--
-- `pushed_at` marks a line as handled for push. The API claims lines with one UPDATE, so when several
-- API processes are running only one of them sends a given line.

CREATE TABLE matrimony.push_devices (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    platform text NOT NULL CHECK (platform IN ('ios', 'android')),
    token text NOT NULL CHECK (char_length(token) BETWEEN 20 AND 4096),
    locale text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn', 'en')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, token),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX push_devices_account ON matrimony.push_devices (agency_id, account_id);

ALTER TABLE matrimony.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.push_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.push_devices
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

-- A device row holds no personal record of the person, only how to reach a phone, so (unlike the rest of
-- the data) the runtime role may delete it: signing out of the app removes its token.
GRANT SELECT, INSERT, DELETE ON matrimony.push_devices TO matrimony_runtime;
GRANT UPDATE (account_id, platform, locale, last_seen_at) ON matrimony.push_devices TO matrimony_runtime;

ALTER TABLE matrimony.notifications ADD COLUMN pushed_at timestamptz;
-- Lines that already exist are not pushed.
UPDATE matrimony.notifications SET pushed_at = now();
GRANT UPDATE (pushed_at) ON matrimony.notifications TO matrimony_runtime;
CREATE INDEX notifications_unpushed ON matrimony.notifications (agency_id, recipient_account_id)
    WHERE pushed_at IS NULL;
