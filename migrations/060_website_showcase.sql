-- "Meet our members": a public showcase of blurred profile cards on the agency's website (27 October 2026).
--
-- Decided with the owner: the agency chooses which published profiles are shown, and the member is not asked for a tick
-- (it would almost never be ticked). Instead the agency's terms say it may happen, and a member or the staff who look
-- after them can switch a profile off (`website_hidden`), and the admin can remove anyone. Only a heavily blurred photo
-- and generic facts ever leave the server (see ShowcaseProcess); no name, no member code, no contact.
--
-- A visitor who likes a card leaves a name and a phone number proved by a text-message code: that is a lead for the
-- agency's staff to call.
ALTER TABLE matrimony.member_profiles
    ADD COLUMN website_hidden boolean NOT NULL DEFAULT false;
GRANT UPDATE (website_hidden) ON matrimony.member_profiles TO matrimony_runtime;

CREATE TABLE matrimony.website_showcase (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    profile_id uuid NOT NULL,
    -- What the public site calls the card, so the profile's own id is never published.
    public_ref uuid NOT NULL DEFAULT gen_random_uuid(),
    added_by uuid NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id),
    UNIQUE (public_ref),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, added_by) REFERENCES matrimony.accounts(agency_id, id)
);

CREATE TABLE matrimony.website_leads (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    -- The card the visitor was looking at, when there was one.
    profile_id uuid,
    name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
    -- Proved with a code, stored as E.164.
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    handled_by uuid,
    handled_at timestamptz,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, handled_by) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX website_leads_recent ON matrimony.website_leads (agency_id, created_at DESC, id);

ALTER TABLE matrimony.website_showcase ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.website_showcase FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.website_showcase
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
ALTER TABLE matrimony.website_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.website_leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.website_leads
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT, DELETE ON matrimony.website_showcase TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.website_leads TO matrimony_runtime;
GRANT UPDATE (status, note, handled_by, handled_at) ON matrimony.website_leads TO matrimony_runtime;
