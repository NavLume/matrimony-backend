-- An admin can delete a payment record (decided with the owner on 21 October 2026).
--
-- Until now a payment was never deleted, only cancelled with a reason. The agency keeps the records of an
-- erased client until its admin decides to delete them, so the admin needs a way to do that. A deletion is not
-- silent: a row here keeps the amount, stage, date and method, why it was deleted and who did it, so the books
-- can still be explained. It holds no name; the profile it belonged to is named by id only.
CREATE TABLE matrimony.payment_deletions (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    payment_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    stage text NOT NULL,
    amount bigint NOT NULL,
    paid_on date NOT NULL,
    method text NOT NULL,
    was_cancelled boolean NOT NULL,
    had_invoice boolean NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 300),
    deleted_by uuid NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, deleted_by) REFERENCES matrimony.accounts(agency_id, id)
);
CREATE INDEX payment_deletions_profile ON matrimony.payment_deletions (agency_id, profile_id, deleted_at);

ALTER TABLE matrimony.payment_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrimony.payment_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON matrimony.payment_deletions
    USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id());
GRANT SELECT ON matrimony.payment_deletions TO matrimony_runtime;

-- The runtime role can never delete, so the work is done by this function, which runs with the owner's rights.
-- It returns the invoice's file key so the caller can delete the file, or no row when there is no such payment.
CREATE FUNCTION matrimony.delete_payment(p_agency uuid, p_profile uuid, p_payment uuid, p_actor uuid, p_reason text)
RETURNS TABLE (deleted_invoice_key text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = matrimony, public AS $$
DECLARE pay record;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  SELECT * INTO pay FROM client_payments
   WHERE agency_id = p_agency AND id = p_payment AND profile_id = p_profile FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO payment_deletions (agency_id, payment_id, profile_id, stage, amount, paid_on, method,
                                 was_cancelled, had_invoice, reason, deleted_by)
  VALUES (p_agency, pay.id, pay.profile_id, pay.stage, pay.amount, pay.paid_on, pay.method,
          pay.voided_at IS NOT NULL, pay.invoice_key IS NOT NULL, p_reason, p_actor);
  DELETE FROM payment_amount_changes WHERE agency_id = p_agency AND payment_id = p_payment;
  DELETE FROM client_payments WHERE agency_id = p_agency AND id = p_payment;
  deleted_invoice_key := pay.invoice_key;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION matrimony.delete_payment(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION matrimony.delete_payment(uuid, uuid, uuid, uuid, text) TO matrimony_runtime;
