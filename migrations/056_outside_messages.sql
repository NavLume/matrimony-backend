-- Messages outside the app: SMS and WhatsApp (22 October 2026).
--
-- A client may not open the site for days, so a new request or a meeting can wait unseen. A member who agrees can be
-- sent a short text message, by SMS or WhatsApp, saying that something is waiting. The text names only the kind of
-- thing (never a name, a photo or a detail), the same lines the mobile push uses; the real line is in the app.
--
--   message_preferences  who agreed to which channel, and when (no row, or 'none', means no messages)
--   outbound_messages    one row for every message sent or tried: who, which channel, which kinds, and whether it
--                        went. It holds no text and no phone number. It is the agency's count of what it spent,
--                        and what the daily limit counts.
--   notifications.messaged_at   the inbox lines already handled for outside delivery, so one is never sent twice
--   meetings.reminded_at        the meeting reminder (the day before) has been added to the inbox
--
-- Nothing is sent until a provider is chosen: with no sender configured the preference cannot be turned on.
CREATE TABLE matrimony.message_preferences (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    account_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('none', 'sms', 'whatsapp')),
    consented_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, account_id),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((channel = 'none') = (consented_at IS NULL))
);
ALTER TABLE matrimony.message_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.message_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.message_preferences
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT, INSERT ON matrimony.message_preferences TO matrimony_runtime;
GRANT UPDATE (channel, consented_at, updated_at) ON matrimony.message_preferences TO matrimony_runtime;

CREATE TABLE matrimony.outbound_messages (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
    kinds text[] NOT NULL,
    status text NOT NULL CHECK (status IN ('sent', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX outbound_messages_recent ON matrimony.outbound_messages (agency_id, created_at DESC);
ALTER TABLE matrimony.outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.outbound_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.outbound_messages
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT, INSERT ON matrimony.outbound_messages TO matrimony_runtime;

ALTER TABLE matrimony.notifications ADD COLUMN messaged_at timestamptz;
-- Every line that exists now was never meant for a text message.
UPDATE matrimony.notifications SET messaged_at = now() WHERE messaged_at IS NULL;
GRANT UPDATE (messaged_at) ON matrimony.notifications TO matrimony_runtime;
CREATE INDEX notifications_to_message ON matrimony.notifications (agency_id, recipient_account_id)
    WHERE messaged_at IS NULL;

ALTER TABLE matrimony.meetings ADD COLUMN reminded_at timestamptz;
UPDATE matrimony.meetings SET reminded_at = now() WHERE reminded_at IS NULL;
GRANT UPDATE (reminded_at) ON matrimony.meetings TO matrimony_runtime;
