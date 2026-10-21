-- Why a proposal was declined, and why a client was not interested after a meeting (21 October 2026).
--
-- Until now a declined proposal was only "declined", and a meeting's feedback had a free-text note. A short pick-list
-- makes the reasons comparable, so an agent can see patterns ("most of this client's no's are about location") and
-- tighten the candidates they release. The reason is private to the agency: the other family never sees it.
-- It is optional (a person may rather not say), and the list is kept in the application, so a reason can be added
-- later without a migration; the database only checks the shape.
ALTER TABLE matrimony.interests
    ADD COLUMN decline_reason text CHECK (decline_reason IS NULL OR decline_reason ~ '^[a-z_]{2,30}$');
GRANT UPDATE (decline_reason) ON matrimony.interests TO matrimony_runtime;

ALTER TABLE matrimony.meeting_feedback
    ADD COLUMN reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{2,30}$'),
    ADD CONSTRAINT meeting_feedback_reason_only_when_not_interested
        CHECK (reason IS NULL OR verdict = 'not_interested');
GRANT UPDATE (reason) ON matrimony.meeting_feedback TO matrimony_runtime;
