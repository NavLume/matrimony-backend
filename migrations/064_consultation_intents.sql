-- Talk to an adviser, aligned with Shammo Bhai's prototype (21 November 2026).
--
-- A visitor chooses what they want first (talk on the phone, visit an office, or WhatsApp), may say who the
-- enquiry is for, may ask for an office visit at a time of day (a request, not an appointment), and when the code
-- never arrives may still leave a call request that stays unverified until staff confirm it on the phone.
-- After verification the visitor is shown the branch's number only, never a staff member's.

ALTER TABLE matrimony.website_leads
    -- What the visitor chose on the first screen. Written once, like the origin.
    ADD COLUMN intent text CHECK (intent IS NULL OR intent IN ('call', 'visit', 'whatsapp')),
    ADD COLUMN for_whom text CHECK (for_whom IS NULL OR for_whom IN ('self', 'child', 'relative', 'later')),
    -- A visit request and the part of the day that suits them; staff confirm the real time.
    ADD COLUMN visit_requested_at timestamptz,
    ADD COLUMN visit_time text CHECK (visit_time IS NULL OR visit_time IN ('morning', 'afternoon', 'any')),
    ADD COLUMN whatsapp_opened_at timestamptz,
    -- When the number was first proved by a code; null while the request is unverified.
    ADD COLUMN verified_at timestamptz;

UPDATE matrimony.website_leads SET verified_at = last_verified_at
 WHERE kind = 'consultation' AND verified_at IS NULL;
UPDATE matrimony.website_leads SET intent = 'call' WHERE kind = 'consultation' AND intent IS NULL;

GRANT UPDATE (for_whom, visit_requested_at, visit_time, whatsapp_opened_at, verified_at)
    ON matrimony.website_leads TO matrimony_runtime;

-- The work number of a staff member is no longer shown to anyone (the branch's number is). The column stays
-- empty and unused; the runtime role may no longer write it.
REVOKE UPDATE (work_phone) ON matrimony.accounts FROM matrimony_runtime;
