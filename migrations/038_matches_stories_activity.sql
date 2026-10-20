-- The matched step, success stories and the activity log (20 October 2026).
--
-- Marking a connection as matched is the end of a successful search. One step records it (who, when, a
-- note), moves both clients to 'matched' so they stop appearing to others, withdraws their other waiting
-- proposals, and sets the success fee each client agrees to pay. It may also start a success story: a
-- short text and the names to show, which can be published only when both clients agreed.
--   couple_matches   one row per matched connection, never changed or deleted
--   success_stories  the story of a match: draft, published or hidden
-- The activity log reads the existing event outbox, so it only needs an index.

CREATE TABLE matrimony.couple_matches (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    interest_id uuid NOT NULL,
    profile_a uuid NOT NULL,
    profile_b uuid NOT NULL,
    matched_by uuid NOT NULL,
    matched_at timestamptz NOT NULL DEFAULT now(),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, interest_id),
    FOREIGN KEY (agency_id, interest_id) REFERENCES matrimony.interests(agency_id, id),
    FOREIGN KEY (agency_id, profile_a) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, profile_b) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, matched_by) REFERENCES matrimony.accounts(agency_id, id)
);

CREATE TABLE matrimony.success_stories (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL,
    -- What is shown: the names and the story, each in Bengali and English (either may be missing).
    names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object'),
    story jsonb CHECK (story IS NULL OR jsonb_typeof(story) = 'object'),
    story_year smallint CHECK (story_year IS NULL OR story_year BETWEEN 1900 AND 2100),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
    -- Each client's agreement to a story, recorded by the staff member who talked with them.
    consent_a_at timestamptz,
    consent_b_at timestamptz,
    consent_by uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, match_id),
    FOREIGN KEY (agency_id, match_id) REFERENCES matrimony.couple_matches(agency_id, id),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, consent_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK (status <> 'published' OR (consent_a_at IS NOT NULL AND consent_b_at IS NOT NULL))
);

ALTER TABLE matrimony.couple_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.couple_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.couple_matches
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
ALTER TABLE matrimony.success_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.success_stories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.success_stories
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.couple_matches TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.success_stories TO matrimony_runtime;
GRANT UPDATE (names, story, story_year, status, consent_a_at, consent_b_at, consent_by, updated_at, published_at)
    ON matrimony.success_stories TO matrimony_runtime;

-- The activity log reads the newest events of an agency.
CREATE INDEX event_outbox_recent ON matrimony.event_outbox (agency_id, created_at DESC, id DESC);
GRANT SELECT ON matrimony.event_outbox TO matrimony_runtime;
