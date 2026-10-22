-- Texts outside the app are SMS only for now (owner decision, 22 October 2026): WhatsApp was built and removed.
-- Any earlier WhatsApp choice becomes "no texts", and the two tables accept only the channels that exist.
UPDATE matrimony.message_preferences SET channel = 'none', consented_at = NULL, updated_at = now()
 WHERE channel = 'whatsapp';

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c' AND conrelid IN ('matrimony.message_preferences'::regclass, 'matrimony.outbound_messages'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%whatsapp%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

ALTER TABLE matrimony.message_preferences
    ADD CONSTRAINT message_preferences_channel_check CHECK (channel IN ('none', 'sms'));
ALTER TABLE matrimony.outbound_messages
    ADD CONSTRAINT outbound_messages_channel_check CHECK (channel IN ('sms'));
