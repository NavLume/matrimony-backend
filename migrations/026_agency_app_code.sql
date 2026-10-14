-- A short code for each agency, for the mobile app (14 October 2026).
--
-- On the website the address tells us the agency. An app has no address, so a person types the agency's
-- code (or opens a link or scans a QR code that carries it). Upper-case letters and digits only, so it
-- is easy to read out and to type on a phone. Optional: an agency without a code is simply not
-- reachable from the app.

ALTER TABLE matrimony.agencies
    ADD COLUMN app_code text UNIQUE CHECK (app_code ~ '^[A-Z0-9]{4,12}$');

-- Give existing agencies a code from their slug, where the slug makes a valid one. If two slugs would
-- give the same code only the first gets it.
WITH candidate AS (
    SELECT id,
           upper(regexp_replace(slug, '[^a-z0-9]', '', 'g')) AS code,
           row_number() OVER (
               PARTITION BY upper(regexp_replace(slug, '[^a-z0-9]', '', 'g'))
               ORDER BY created_at, id
           ) AS rank
    FROM matrimony.agencies
)
UPDATE matrimony.agencies a
SET app_code = c.code
FROM candidate c
WHERE a.id = c.id
  AND c.rank = 1
  AND c.code ~ '^[A-Z0-9]{4,12}$';
