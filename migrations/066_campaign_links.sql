-- Lead capture, phase A step 3 (21 November 2026): tagged links and QR codes made by staff.
--
-- Every place the agency puts a link (a Facebook ad or post, a WhatsApp group, the old website's buttons, a QR code
-- printed for an event or an office) gets its own tagged link, made here so nobody types tags by hand. Agents and
-- admins may make them (owner decision). A link's campaign name (`slug`) is what the visitor's enquiry records as
-- utm_campaign, so each link's enquiries can be counted.
--
-- WhatsApp becomes its own lead source: links shared in WhatsApp groups are a main channel in Bangladesh.

ALTER TABLE matrimony.website_leads DROP CONSTRAINT website_leads_source_check;
ALTER TABLE matrimony.website_leads
    ADD CONSTRAINT website_leads_source_check CHECK (
        source IS NULL OR source IN ('qr', 'google', 'facebook', 'whatsapp', 'old_site', 'other_site', 'direct'));

CREATE TABLE matrimony.campaign_links (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    -- Where the link will be put; decides its tags.
    kind text NOT NULL CHECK (kind IN ('facebook_ad', 'facebook_post', 'whatsapp', 'old_site', 'event_qr',
                                       'office_qr', 'other')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
    -- The campaign tag (utm_campaign): lower-case letters, digits and dashes; unique in the agency.
    slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60),
    -- For an office QR code: the office's position in the agency's list (0, 1 or 2).
    office smallint CHECK (office IS NULL OR office BETWEEN 0 AND 2),
    -- The site language the link opens in.
    locale text NOT NULL DEFAULT 'bn' CHECK (locale IN ('bn', 'en')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Put away: hidden from the list; the link itself keeps working and its enquiries keep their campaign.
    archived_at timestamptz,
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, slug),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((kind = 'office_qr') = (office IS NOT NULL))
);
CREATE INDEX campaign_links_recent ON matrimony.campaign_links (agency_id, created_at DESC);
CREATE INDEX website_leads_campaign ON matrimony.website_leads (agency_id, utm_campaign) WHERE utm_campaign IS NOT NULL;

ALTER TABLE matrimony.campaign_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.campaign_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.campaign_links
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.campaign_links TO matrimony_runtime;
GRANT UPDATE (archived_at) ON matrimony.campaign_links TO matrimony_runtime;
