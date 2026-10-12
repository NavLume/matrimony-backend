-- Staff management and the nightly refresh (slices 3.L and 3.M, decided 12 October 2026).
--
-- 3.L. An admin may disable and re-enable a staff account, so the runtime role may change the
-- status column of an account (and no other). Who looked after a client is kept as a history: one row
-- for every change of agent, never changed or deleted.
GRANT UPDATE (status) ON matrimony.accounts TO matrimony_runtime;

CREATE TABLE matrimony.client_assignments (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    from_agent_id uuid,
    to_agent_id uuid,
    -- Null for the rows written from what existed before this history was kept.
    changed_by_account_id uuid,
    reason text NOT NULL CHECK (reason IN ('assigned', 'handed_over', 'earlier')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, from_agent_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, to_agent_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, changed_by_account_id) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX client_assignments_profile ON matrimony.client_assignments (agency_id, profile_id, created_at DESC);

ALTER TABLE matrimony.client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_assignments
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT, INSERT ON matrimony.client_assignments TO matrimony_runtime;

-- Whoever looks after a client today is where their history begins.
INSERT INTO matrimony.client_assignments (agency_id, profile_id, from_agent_id, to_agent_id, reason, created_at)
SELECT agency_id, id, NULL, assigned_agent_id, 'earlier', created_at
  FROM matrimony.member_profiles WHERE assigned_agent_id IS NOT NULL;

-- 3.M. A job that runs once a day for an agency remembers when it last ran, so two processes, or a
-- restart, never run it twice in one day.
CREATE TABLE matrimony.job_runs (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    name text NOT NULL CHECK (btrim(name) <> ''),
    last_run_at timestamptz NOT NULL,
    PRIMARY KEY (agency_id, name)
);
ALTER TABLE matrimony.job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.job_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.job_runs
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT, INSERT ON matrimony.job_runs TO matrimony_runtime;
GRANT UPDATE (last_run_at) ON matrimony.job_runs TO matrimony_runtime;
