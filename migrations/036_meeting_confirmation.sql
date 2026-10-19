-- A meeting the other side has to confirm (19 October 2026).
--
-- When the two clients of an accepted proposal have different agents, a meeting set by one side is only
-- proposed: the other side (their agent, an admin, or the client themselves) confirms it or suggests
-- another time. Only a confirmed meeting counts as scheduled. When both clients have the same agent, or
-- an admin sets it, it is confirmed at once, as before.
--   proposed_side  the client profile whose side made the current proposal; the other side answers
--   confirmed_at/by who accepted it
-- Rows that exist stay as they are: 'scheduled' means confirmed.

ALTER TABLE matrimony.meetings DROP CONSTRAINT meetings_status_check;
ALTER TABLE matrimony.meetings ADD CONSTRAINT meetings_status_check
    CHECK (status IN ('proposed', 'scheduled', 'done', 'cancelled'));

ALTER TABLE matrimony.meetings
    ADD COLUMN proposed_side uuid,
    ADD COLUMN confirmed_at timestamptz,
    ADD COLUMN confirmed_by uuid,
    ADD FOREIGN KEY (agency_id, proposed_side) REFERENCES matrimony.member_profiles(agency_id, id),
    ADD FOREIGN KEY (agency_id, confirmed_by) REFERENCES matrimony.accounts(agency_id, id),
    ADD CHECK (status <> 'proposed' OR proposed_side IS NOT NULL);

DROP INDEX matrimony.meetings_open;
CREATE INDEX meetings_open ON matrimony.meetings (agency_id, scheduled_at) WHERE status IN ('proposed', 'scheduled');

GRANT UPDATE (proposed_side, confirmed_at, confirmed_by) ON matrimony.meetings TO matrimony_runtime;
