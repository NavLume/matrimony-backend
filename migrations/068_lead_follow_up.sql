-- Lead follow-up, phase B (21 November 2026): every enquiry is called within a time limit, and every call is written
-- down.
--
-- The agency's admin sets the limit (default 2 hours, counted in office hours, Bangladesh time; owner decision
-- 21 November 2026). An enquiry nobody has tried to call by then reminds its agent (or, with no agent, the admins);
-- one still not tried after a second limit tells the admins. Writing down a call (whatever came of it) or moving the
-- enquiry on from "new" counts as the first contact and stops both.

ALTER TABLE matrimony.website_leads
    -- The first call written down, or the first move away from "new".
    ADD COLUMN first_contact_at timestamptz,
    ADD COLUMN followup_reminded_at timestamptz,
    ADD COLUMN followup_escalated_at timestamptz;

GRANT UPDATE (first_contact_at, followup_reminded_at, followup_escalated_at)
    ON matrimony.website_leads TO matrimony_runtime;

-- Existing enquiries already handled count as contacted, so the first round does not remind about old ones.
UPDATE matrimony.website_leads SET first_contact_at = coalesce(handled_at, created_at) WHERE status <> 'new';

-- Each call staff make to an enquiry, and what came of it. Never edited or deleted.
CREATE TABLE matrimony.lead_calls (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    lead_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('no_answer', 'interested', 'not_interested', 'call_later',
                                             'visit_booked', 'wrong_number')),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    -- For "call me later": when they asked to be called again.
    call_again_at timestamptz,
    called_by uuid NOT NULL,
    called_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, lead_id) REFERENCES matrimony.website_leads(agency_id, id),
    FOREIGN KEY (agency_id, called_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (call_again_at IS NULL OR outcome = 'call_later')
);
CREATE INDEX lead_calls_lead ON matrimony.lead_calls (agency_id, lead_id, called_at DESC);

ALTER TABLE matrimony.lead_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.lead_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.lead_calls
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.lead_calls TO matrimony_runtime;
