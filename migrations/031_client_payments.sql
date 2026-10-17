-- Payments recorded in the office (decided with the friend on 16 October 2026).
--
-- Money is paid outside the platform, in the agency's office. The platform only keeps the record: what
-- each client agreed to pay for each of two stages, and every payment received, with its invoice file.
--   registration  the fee before a match
--   success       the fee after a match
-- Amounts are whole taka. A payment is never changed or deleted: a mistake is cancelled (voided) by an
-- admin with a reason, and a new payment is entered. The invoice file may be attached once.
-- The runtime role may add rows, set an agreement, attach an invoice and void a payment, nothing else.

CREATE TABLE matrimony.client_agreements (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    profile_id uuid NOT NULL,
    stage text NOT NULL CHECK (stage IN ('registration', 'success')),
    amount bigint NOT NULL CHECK (amount >= 0 AND amount <= 100000000),
    set_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, profile_id, stage),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, set_by) REFERENCES matrimony.accounts(agency_id, id)
);

CREATE TABLE matrimony.client_payments (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL,
    stage text NOT NULL CHECK (stage IN ('registration', 'success')),
    amount bigint NOT NULL CHECK (amount > 0 AND amount <= 100000000),
    paid_on date NOT NULL,
    method text NOT NULL CHECK (method IN ('cash', 'bank', 'bkash', 'other')),
    reference text CHECK (reference IS NULL OR char_length(reference) <= 60),
    note text CHECK (note IS NULL OR char_length(note) <= 300),
    -- For a success fee: the accepted proposal it came from.
    interest_id uuid,
    received_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    invoice_key text,
    invoice_name text CHECK (invoice_name IS NULL OR char_length(invoice_name) BETWEEN 1 AND 120),
    invoice_mime text CHECK (invoice_mime IS NULL OR invoice_mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    invoice_size integer CHECK (invoice_size IS NULL OR invoice_size BETWEEN 1 AND 5242880),
    voided_at timestamptz,
    voided_by uuid,
    void_reason text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 3 AND 300),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, profile_id) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, received_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, voided_by) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, interest_id) REFERENCES matrimony.interests(agency_id, id),
    CHECK (interest_id IS NULL OR stage = 'success'),
    CHECK ((invoice_key IS NULL) = (invoice_name IS NULL)
       AND (invoice_key IS NULL) = (invoice_mime IS NULL)
       AND (invoice_key IS NULL) = (invoice_size IS NULL)),
    CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX client_payments_by_profile ON matrimony.client_payments (agency_id, profile_id, paid_on DESC);
CREATE INDEX client_payments_by_day ON matrimony.client_payments (agency_id, paid_on);
CREATE UNIQUE INDEX client_payments_invoice_key ON matrimony.client_payments (agency_id, invoice_key)
    WHERE invoice_key IS NOT NULL;

ALTER TABLE matrimony.client_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_agreements
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

ALTER TABLE matrimony.client_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.client_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.client_payments
    USING (agency_id = matrimony.current_agency_id())
    WITH CHECK (agency_id = matrimony.current_agency_id());

GRANT SELECT, INSERT ON matrimony.client_agreements TO matrimony_runtime;
GRANT UPDATE (amount, set_by, updated_at) ON matrimony.client_agreements TO matrimony_runtime;
GRANT SELECT, INSERT ON matrimony.client_payments TO matrimony_runtime;
GRANT UPDATE (invoice_key, invoice_name, invoice_mime, invoice_size, voided_at, voided_by, void_reason)
    ON matrimony.client_payments TO matrimony_runtime;
