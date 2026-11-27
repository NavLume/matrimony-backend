-- A registration is a lead too (28 November 2026, Shammo Bhai's feedback): someone who fills in the registration form
-- and is sent an email link has no account until they open it. Until now nothing was kept, so an unopened email was a
-- lost lead and a lost entry in the revenue-share count. The registration now saves (or marks) an enquiry for the
-- mobile number at once, as a call request, and this column says when it came from the registration form. A person
-- who registers again with the same number marks the same open enquiry, so the runtime may write it.

ALTER TABLE matrimony.website_leads
    ADD COLUMN registration_started_at timestamptz;

GRANT UPDATE (registration_started_at) ON matrimony.website_leads TO matrimony_runtime;
