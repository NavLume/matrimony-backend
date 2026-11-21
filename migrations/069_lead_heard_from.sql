-- Lead capture, phase B (21 November 2026): the visitor may say where they heard of the agency.
--
-- What the visitor says is kept apart from where the browser says they came from (`source`): it is a second piece of
-- evidence for the cases the browser cannot see (a link opened on another phone, an advert seen and the address typed,
-- a friend's word). Optional, written once with the enquiry, never changed by staff.

ALTER TABLE matrimony.website_leads
    ADD COLUMN heard_from text CHECK (heard_from IS NULL OR heard_from IN
        ('facebook', 'google', 'youtube', 'whatsapp', 'friend', 'event', 'office', 'other'));
