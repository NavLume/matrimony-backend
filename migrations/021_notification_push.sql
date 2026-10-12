-- Live notifications (answer 2 of 12 October 2026).
--
-- Whenever an inbox line is added, the database says so on the `notifications` channel, naming the
-- agency and the account but nothing else. The API process listens, and tells the browser tabs of that
-- account that something new is there; the tab then asks for the count and the list in the usual
-- way, with its own sign-in. No inbox text ever travels on this channel, so what it carries is not
-- worth reading. It fires after the transaction commits, so a rolled-back change never notifies.
CREATE FUNCTION matrimony.push_notification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'notifications',
    json_build_object('agency', NEW.agency_id, 'account', NEW.recipient_account_id)::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_push AFTER INSERT ON matrimony.notifications
    FOR EACH ROW EXECUTE FUNCTION matrimony.push_notification();
