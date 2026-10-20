-- The total fee (20 October 2026).
--
-- A client's agreement is now one total amount for the whole service, recorded beside the registration fee
-- (paid first) and the success fee (paid after a match), which are payments. The total is kept as a third
-- agreement row. Older agreements per stage stay; where a total exists it is the agreed amount.

ALTER TABLE matrimony.client_agreements DROP CONSTRAINT IF EXISTS client_agreements_stage_check;
ALTER TABLE matrimony.client_agreements
    ADD CONSTRAINT client_agreements_stage_check CHECK (stage IN ('registration', 'success', 'total'));
