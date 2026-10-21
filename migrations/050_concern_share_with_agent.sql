-- A reporter can let their own agent read a concern too (21 October 2026). Private by default. Not available for a
-- concern about the agency's staff, which may be about the agent.

ALTER TABLE matrimony.concern_reports
    ADD COLUMN share_with_agent boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT concern_reports_share_not_about_staff CHECK (NOT share_with_agent OR about_kind <> 'agency');
