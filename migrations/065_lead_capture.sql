-- Lead capture, phase A steps 1 and 2 (21 November 2026, Shammo Bhai: make the acquisition flow smooth).
--
-- 1. Where a visitor came from is read more surely:
--    - the agency's old website is its own source ("old_site"), from its tag or because the browser said the
--      visitor came from one of the old site's addresses (set by the admin);
--    - a click from a Facebook or Google ad carries the network's own click id (fbclid, gclid). It is kept as the
--      kind of click (never the id itself), so a link that lost its tags still shows the network.
-- 2. A visitor who asked for a code is a lead already: the enquiry is saved the moment the code is asked for, so a
--    person who never types the code is not lost. Staff may call them (owner decision, 21 November 2026).

ALTER TABLE matrimony.website_leads DROP CONSTRAINT website_leads_source_check;
ALTER TABLE matrimony.website_leads
    ADD CONSTRAINT website_leads_source_check
        CHECK (source IS NULL OR source IN ('qr', 'google', 'facebook', 'old_site', 'other_site', 'direct')),
    -- Which ad network's click id the landing address carried. Origin: written once, never updated.
    ADD COLUMN click_id text CHECK (click_id IS NULL OR click_id IN ('facebook', 'google')),
    -- When a code was last asked for this enquiry.
    ADD COLUMN code_sent_at timestamptz;

GRANT UPDATE (code_sent_at) ON matrimony.website_leads TO matrimony_runtime;
