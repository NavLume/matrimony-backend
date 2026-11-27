-- Talk to an adviser (27 November 2026, owner decision): the visitor may also leave an email address, on every path
-- (call, visit, WhatsApp). Optional; the mobile number stays the one that is proved. A visitor who comes back with the
-- same number and gives an address (or a new one) updates it, so the runtime may write this column.

ALTER TABLE matrimony.website_leads
    ADD COLUMN email text CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email LIKE '%_@_%'));

GRANT UPDATE (email) ON matrimony.website_leads TO matrimony_runtime;
