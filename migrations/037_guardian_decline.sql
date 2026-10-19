-- A guardian request the client declines (19 October 2026).
--
-- A request that is still waiting for the client has no consent yet. When the client declines it (or the
-- agency cancels it), the row becomes 'removed' with no consent recorded, which the first check forbade.

ALTER TABLE matrimony.profile_guardians DROP CONSTRAINT profile_guardians_check;
ALTER TABLE matrimony.profile_guardians ADD CONSTRAINT profile_guardians_consent_check
    CHECK (status IN ('awaiting_client', 'removed')
        OR (consent_basis IS NOT NULL AND consented_at IS NOT NULL AND consented_by IS NOT NULL));
