-- Lead reports, phase C (21 November 2026): how many people arrive from each source, so the lead funnel can start
-- at the visit.
--
-- Only counts are kept: per agency, Bangladesh day, source and campaign. No person, address, cookie or device is
-- stored. The browser reports an arrival once (the first one, or a new tagged one), the same moment it remembers the
-- origin for an enquiry.

CREATE TABLE matrimony.site_visits (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    day date NOT NULL,
    source text NOT NULL CHECK (source IN ('qr', 'google', 'facebook', 'whatsapp', 'old_site', 'other_site', 'direct')),
    -- The link's campaign name (utm_campaign), or empty.
    campaign text NOT NULL DEFAULT '' CHECK (char_length(campaign) <= 100),
    visits integer NOT NULL DEFAULT 0 CHECK (visits >= 0),
    PRIMARY KEY (agency_id, day, source, campaign)
);

ALTER TABLE matrimony.site_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.site_visits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.site_visits
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.site_visits TO matrimony_runtime;
GRANT UPDATE (visits) ON matrimony.site_visits TO matrimony_runtime;
