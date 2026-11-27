-- Talk to an adviser for Bangladeshis abroad (27 November 2026, Shammo Bhai's feedback points 4 and 7).
--
-- A visitor chooses their country. In Bangladesh the mobile number is proved by a text-message code, as before.
-- Abroad no text is sent: the email is proved by a code instead, and a WhatsApp number may be left so an adviser can
-- reach them. `country_code` is written once with the enquiry; `email_verified_at` is set when the emailed code is
-- typed (and again kept on a later proof); `whatsapp_e164` may be updated when the visitor comes back.

ALTER TABLE matrimony.website_leads
    ADD COLUMN country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN whatsapp_e164 text CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    ADD COLUMN email_verified_at timestamptz;

GRANT UPDATE (email_verified_at, whatsapp_e164) ON matrimony.website_leads TO matrimony_runtime;

-- Leads are also joined to clients by a proved email (a client abroad may register with another number).
CREATE INDEX website_leads_unlinked_email
    ON matrimony.website_leads (agency_id, email)
    WHERE client_profile_id IS NULL AND email_verified_at IS NOT NULL;
