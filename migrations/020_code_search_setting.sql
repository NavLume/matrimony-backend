-- Searching by member code is switched on by staff, per client (slice 3.M, answer 28 of 12 October 2026).
-- Until staff turn it on, a client's filter box has no member code field. It still only finds
-- profiles in the client's own released window: it never reaches anyone staff did not release.
ALTER TABLE matrimony.client_release_settings
    ADD COLUMN allow_code_search boolean NOT NULL DEFAULT false;
GRANT UPDATE (allow_code_search) ON matrimony.client_release_settings TO matrimony_runtime;
