-- A couple photo and a wedding date for a success story (home-page stories, 27 October 2026).
--
-- The photo is stored by the platform (see SiteContentService) and shown only while the story is published, which
-- already needs both clients' agreement. Removing a story deletes its photo as well, so a removed story cannot keep
-- a face on the site.
ALTER TABLE matrimony.success_stories
    ADD COLUMN photo_file text CHECK (photo_file IS NULL OR photo_file ~ '^story-[0-9a-f-]{36}\.webp$'),
    ADD COLUMN wedding_date date,
    ADD CONSTRAINT success_stories_removed_has_no_photo CHECK (removed_at IS NULL OR photo_file IS NULL);

GRANT UPDATE (photo_file, wedding_date) ON matrimony.success_stories TO matrimony_runtime;
