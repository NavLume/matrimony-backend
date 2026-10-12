-- Every client has an agent from the start (answer 5 of 12 October 2026, confirmed 13 October).
--
-- A profile created without an agent is given to the active agent who looks after the fewest clients.
-- The history records it as `automatic`, with nobody as the person who made the change. If the agency
-- has no active agent yet, the profile stays unassigned and the admins are told.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'matrimony.client_assignments'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%handed_over%'
  LOOP
    EXECUTE format('ALTER TABLE matrimony.client_assignments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE matrimony.client_assignments
    ADD CONSTRAINT client_assignments_reason_check
    CHECK (reason IN ('assigned', 'handed_over', 'earlier', 'automatic'));
