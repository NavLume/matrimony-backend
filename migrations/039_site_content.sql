-- The agency admin edits the public site's words (contact, home, about, branches) from the admin
-- dashboard. The runtime role may change only the content, never the name, host or status.
GRANT UPDATE (public_config, updated_at) ON matrimony.agencies TO matrimony_runtime;
