-- Lead capture, phase A step 5 (21 November 2026): a website enquiry is joined to the client it becomes.
--
-- The revenue share with the agency is counted per lead (a person who left a lead on the platform and later became a
-- client, however they were then handled). So each enquiry is linked to its client:
--   - automatically, by mobile number: the client's own login number or the contact number on their profile. A number
--     shared by two or more clients (a parent registering two children) is never linked automatically; staff choose.
--   - by staff, by member code, when the client registered with another number.
-- The enquiry's own time (created_at) and the profile's own time (created_at) are both kept and never changed, so the
-- order (enquiry first, or client first) can be shown. Only an admin may undo a link.

ALTER TABLE matrimony.website_leads
    ADD COLUMN client_profile_id uuid,
    ADD COLUMN linked_at timestamptz,
    ADD COLUMN linked_by uuid,
    ADD COLUMN link_method text CHECK (link_method IS NULL OR link_method IN ('auto', 'staff')),
    -- An admin undid a link: the number is not linked automatically again (staff may still link by member code).
    ADD COLUMN auto_link_blocked boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT website_leads_client_fk FOREIGN KEY (agency_id, client_profile_id)
        REFERENCES matrimony.member_profiles(agency_id, id),
    ADD CONSTRAINT website_leads_linked_by_fk FOREIGN KEY (agency_id, linked_by)
        REFERENCES matrimony.accounts(agency_id, id),
    ADD CONSTRAINT website_leads_link_complete CHECK (
        (client_profile_id IS NULL AND linked_at IS NULL AND link_method IS NULL AND linked_by IS NULL)
        OR (client_profile_id IS NOT NULL AND linked_at IS NOT NULL AND link_method IS NOT NULL
            AND (link_method = 'auto') = (linked_by IS NULL)));

CREATE INDEX website_leads_client ON matrimony.website_leads (agency_id, client_profile_id)
    WHERE client_profile_id IS NOT NULL;
CREATE INDEX website_leads_unlinked ON matrimony.website_leads (agency_id, phone_e164)
    WHERE client_profile_id IS NULL;

GRANT UPDATE (client_profile_id, linked_at, linked_by, link_method, auto_link_blocked)
    ON matrimony.website_leads TO matrimony_runtime;
