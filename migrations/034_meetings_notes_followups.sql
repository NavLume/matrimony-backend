-- Meetings, private notes and follow-ups (17 October 2026).
--
-- After a proposal is accepted the real work is offline: a family meeting, a visit, a decision. The
-- agent records the meeting (when, where, what kind), can change or cancel it, marks it done, and
-- records what each side said afterwards. Both people are told when a meeting is set or changed.
--   meetings            one row per meeting of an accepted proposal
--   meeting_feedback    what each side's agent recorded after a meeting, private to the office
--   client_notes        private notes of staff about a client, never shown to the client
--   client_follow_ups   a reminder with a due day, for the agent who looks after the client
-- Notes and feedback are never changed or deleted; a mistake is answered by a newer line. The runtime
-- role may add rows, change a meeting, record feedback again, and mark a follow-up done.

CREATE TABLE matrimony.meetings (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    interest_id uuid NOT NULL,
    scheduled_at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('first_meeting', 'family_meeting', 'visit', 'call', 'other')),
    place text CHECK (place IS NULL OR char_length(place) BETWEEN 1 AND 200),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, interest_id) REFERENCES matrimony.interests(agency_id, id),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX meetings_by_interest ON matrimony.meetings (agency_id, interest_id, scheduled_at DESC);
CREATE INDEX meetings_open ON matrimony.meetings (agency_id, scheduled_at) WHERE status = 'scheduled';

CREATE TABLE matrimony.meeting_feedback (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    meeting_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('interested', 'undecided', 'not_interested')),
    note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    recorded_by uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, meeting_id, profile_id),
    FOREIGN KEY (agency_id, meeting_id) REFERENCES matrimony.meetings(agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, recorded_by) REFERENCES matrimony.accounts(agency_id, id)
);

CREATE TABLE matrimony.client_notes (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    author_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, author_id) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX client_notes_by_profile ON matrimony.client_notes (agency_id, profile_id, created_at DESC);

CREATE TABLE matrimony.client_follow_ups (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    due_on date NOT NULL,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    assigned_to uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    done_at timestamptz,
    done_by uuid,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, assigned_to) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, created_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, done_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX follow_ups_by_profile ON matrimony.client_follow_ups (agency_id, profile_id, due_on);
CREATE INDEX follow_ups_open ON matrimony.client_follow_ups (agency_id, assigned_to, due_on) WHERE done_at IS NULL;

ALTER TABLE matrimony.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.meetings
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
ALTER TABLE matrimony.meeting_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.meeting_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.meeting_feedback
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
ALTER TABLE matrimony.client_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_notes
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
ALTER TABLE matrimony.client_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_follow_ups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_follow_ups
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.meetings TO matrimony_runtime;
GRANT UPDATE (scheduled_at, kind, place, note, status, updated_at) ON matrimony.meetings TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.meeting_feedback TO matrimony_runtime;
GRANT UPDATE (verdict, note, recorded_by, recorded_at) ON matrimony.meeting_feedback TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.client_notes TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.client_follow_ups TO matrimony_runtime;
GRANT UPDATE (done_at, done_by) ON matrimony.client_follow_ups TO matrimony_runtime;
