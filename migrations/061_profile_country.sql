-- The country a person lives in (27 October 2026, for the "Meet our members" browse page and the agency's clients
-- abroad). Empty means Bangladesh. The value is a permanent code from src/bo/dictionaries.ts, checked by the
-- application like the other code columns; the table's column grants already cover it.
ALTER TABLE matrimony.member_profiles
    ADD COLUMN country_code text;