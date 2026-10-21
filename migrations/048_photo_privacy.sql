-- Photo privacy (21 October 2026).
--
-- A profile's owner (or, for an assisted client, the agent) can choose that other members see the photos blurred
-- until a proposal between them is accepted. The blurred picture is made by the server from a small copy, so the
-- clear picture is never sent before then. Photos that are shown clearly carry the viewer's member code as a
-- watermark, so a copy that is passed on can be traced. 'clear' keeps today's behaviour and is the default.

ALTER TABLE matrimony.member_profiles
    ADD COLUMN photo_privacy text NOT NULL DEFAULT 'clear'
        CHECK (photo_privacy IN ('clear', 'blurred'));

GRANT UPDATE (photo_privacy) ON matrimony.member_profiles TO matrimony_runtime;
