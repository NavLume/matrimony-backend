-- The agency's own settings (21 October 2026): one JSON value set by its admin. The first setting is after how many
-- days each kind of waiting item counts as overdue on the agenda. A missing value means the defaults.

ALTER TABLE matrimony.agencies ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
GRANT UPDATE (settings) ON matrimony.agencies TO matrimony_runtime;
