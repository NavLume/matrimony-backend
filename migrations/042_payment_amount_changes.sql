-- An admin can change the amount of a recorded payment (decided with the owner on 20 October 2026). The
-- earlier amount is never lost: every change is a row here, with who made it, when and why. A payment
-- is still never deleted.
CREATE TABLE matrimony.payment_amount_changes (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    payment_id uuid NOT NULL,
    old_amount bigint NOT NULL CHECK (old_amount >= 0),
    new_amount bigint NOT NULL CHECK (new_amount >= 0),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    CHECK (old_amount <> new_amount),
    FOREIGN KEY (agency_id, payment_id) REFERENCES matrimony.client_payments(agency_id, id),
    FOREIGN KEY (agency_id, changed_by) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX payment_amount_changes_payment ON matrimony.payment_amount_changes (agency_id, payment_id, changed_at);

ALTER TABLE matrimony.payment_amount_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.payment_amount_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.payment_amount_changes
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.payment_amount_changes TO matrimony_runtime;
GRANT UPDATE (amount) ON matrimony.client_payments TO matrimony_runtime;
