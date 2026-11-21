-- Talk to an adviser (Shammo Bhai's guideline and NavLume's lead traceability brief, 21 November 2026).
--
-- A visitor from a QR code, Google, Facebook or anywhere else leaves a name and a mobile number, proves the number
-- with a code, and only then sees the number of the adviser chosen for them (or asks to be called). The lead is kept
-- with where the visitor came from, so the agency can show later that a client who walked into an office came
-- through a digital channel. A lead from the "Meet our members" cards is the same thing with a card attached.
--
-- Origin is written once, when the lead is created: the runtime role may not update those columns, so staff can
-- never rewrite where a lead came from.

ALTER TABLE matrimony.website_leads
    -- What the visitor used: the general "talk to an adviser" flow, or a showcase card.
    ADD COLUMN kind text NOT NULL DEFAULT 'showcase' CHECK (kind IN ('showcase', 'consultation')),
    -- The number the visitor is told to keep and say at the office. Unique per agency.
    ADD COLUMN reference text CHECK (reference IS NULL OR reference ~ '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$'),
    -- Where they came from, as the server read it: qr, google, facebook, other_site or direct.
    ADD COLUMN source text CHECK (source IS NULL OR source IN ('qr', 'google', 'facebook', 'other_site', 'direct')),
    ADD COLUMN utm_source text CHECK (utm_source IS NULL OR char_length(utm_source) <= 100),
    ADD COLUMN utm_medium text CHECK (utm_medium IS NULL OR char_length(utm_medium) <= 100),
    ADD COLUMN utm_campaign text CHECK (utm_campaign IS NULL OR char_length(utm_campaign) <= 100),
    ADD COLUMN utm_content text CHECK (utm_content IS NULL OR char_length(utm_content) <= 100),
    -- Only the host of the page that sent them (never the full address, which can carry personal data).
    ADD COLUMN referrer_host text CHECK (referrer_host IS NULL OR char_length(referrer_host) <= 200),
    -- The first page of the site they opened, without its query.
    ADD COLUMN landing_path text CHECK (landing_path IS NULL OR char_length(landing_path) <= 300),
    -- When they first arrived (from the browser; a hint, not proof).
    ADD COLUMN first_seen_at timestamptz,
    -- The office they chose (its English name at the time), if any.
    ADD COLUMN office text CHECK (office IS NULL OR char_length(office) <= 120),
    -- The adviser whose number they were shown.
    ADD COLUMN assigned_agent_id uuid,
    -- They pressed "Please call me", and when.
    ADD COLUMN callback_requested_at timestamptz,
    -- They pressed the button that dials the adviser, and when (the first time).
    ADD COLUMN call_clicked_at timestamptz,
    -- They came back with the same number and proved it again.
    ADD COLUMN last_verified_at timestamptz,
    ADD COLUMN visits integer NOT NULL DEFAULT 1 CHECK (visits >= 1),
    -- A hash of the random ticket the visitor's browser holds, so only they can ask for the call.
    ADD COLUMN ticket_hash text CHECK (ticket_hash IS NULL OR char_length(ticket_hash) = 64),
    ADD CONSTRAINT website_leads_agent_fk FOREIGN KEY (agency_id, assigned_agent_id)
        REFERENCES matrimony.accounts(agency_id, id),
    ADD CONSTRAINT website_leads_consultation_has_reference CHECK (kind <> 'consultation' OR reference IS NOT NULL);

CREATE UNIQUE INDEX website_leads_reference ON matrimony.website_leads (agency_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX website_leads_phone ON matrimony.website_leads (agency_id, phone_e164, created_at DESC);
CREATE INDEX website_leads_agent ON matrimony.website_leads (agency_id, assigned_agent_id, created_at DESC);

-- Origin columns stay out of this list on purpose.
GRANT UPDATE (assigned_agent_id, callback_requested_at, call_clicked_at, last_verified_at, visits, ticket_hash)
    ON matrimony.website_leads TO matrimony_runtime;

-- The number a visitor is shown for an adviser: a work number the admin sets, not the staff member's own login phone.
ALTER TABLE matrimony.accounts
    ADD COLUMN work_phone text CHECK (work_phone IS NULL OR work_phone ~ '^\+[1-9][0-9]{7,14}$');
GRANT UPDATE (work_phone) ON matrimony.accounts TO matrimony_runtime;
