-- Chat between two clients after an accepted proposal (decided with the owner on 17 October 2026).
--
-- - Both sides must agree: one asks, the other accepts. Text only. Phone numbers, emails and links are
--   hidden in the text before it is stored.
-- - Private by default. Staff read a conversation only when it has been reported, or when one of the two
--   people invited their own agent into it; each reading is logged, and both people see who is in it.
-- - It ends when either profile stops being published (paused, matched, closed), or when a person ends it,
--   blocks the other, or staff end it. Messages are erased 90 days after it ended; deleting an account
--   erases that person's conversations at once.
-- - The platform owner can turn chat off for an agency (`agencies.chat_enabled`).
--
-- The runtime role may add rows and move them along, never delete: the functions at the end erase.

ALTER TABLE matrimony.agencies ADD COLUMN chat_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE matrimony.chat_conversations (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    interest_id uuid NOT NULL,
    profile_a uuid NOT NULL,
    profile_b uuid NOT NULL,
    requested_by uuid NOT NULL,
    status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'active', 'ended')),
    end_reason text CHECK (end_reason IN ('declined', 'ended_by_member', 'blocked', 'profile_unavailable',
                                          'ended_by_staff', 'account_deleted')),
    ended_by uuid,
    requested_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    ended_at timestamptz,
    last_message_at timestamptz,
    PRIMARY KEY (agency_id, id),
    UNIQUE (agency_id, interest_id),
    FOREIGN KEY (agency_id, interest_id) REFERENCES matrimony.interests(agency_id, id),
    FOREIGN KEY (agency_id, profile_a) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, profile_b) REFERENCES matrimony.member_profiles(agency_id, id),
    CHECK (profile_a <> profile_b),
    CHECK (requested_by IN (profile_a, profile_b)),
    CHECK ((status = 'ended') = (ended_at IS NOT NULL AND end_reason IS NOT NULL))
);
CREATE INDEX chat_conversations_a ON matrimony.chat_conversations (agency_id, profile_a);
CREATE INDEX chat_conversations_b ON matrimony.chat_conversations (agency_id, profile_b);

CREATE TABLE matrimony.chat_messages (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    sender_profile_id uuid NOT NULL,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    masked boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, conversation_id) REFERENCES matrimony.chat_conversations(agency_id, id),
    FOREIGN KEY (agency_id, sender_profile_id) REFERENCES matrimony.member_profiles(agency_id, id)
);
CREATE INDEX chat_messages_by_conversation
    ON matrimony.chat_messages (agency_id, conversation_id, created_at DESC, id DESC);

CREATE TABLE matrimony.chat_reports (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    reported_by uuid NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid,
    resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, conversation_id) REFERENCES matrimony.chat_conversations(agency_id, id),
    FOREIGN KEY (agency_id, reported_by) REFERENCES matrimony.member_profiles(agency_id, id),
    FOREIGN KEY (agency_id, resolved_by) REFERENCES matrimony.accounts(agency_id, id),
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE INDEX chat_reports_open ON matrimony.chat_reports (agency_id, created_at) WHERE resolved_at IS NULL;

CREATE TABLE matrimony.chat_chaperones (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    conversation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    invited_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    PRIMARY KEY (agency_id, conversation_id, account_id),
    FOREIGN KEY (agency_id, conversation_id) REFERENCES matrimony.chat_conversations(agency_id, id),
    FOREIGN KEY (agency_id, account_id) REFERENCES matrimony.accounts(agency_id, id),
    FOREIGN KEY (agency_id, invited_by) REFERENCES matrimony.member_profiles(agency_id, id)
);

CREATE TABLE matrimony.chat_access_log (
    agency_id uuid NOT NULL REFERENCES matrimony.agencies(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    staff_account_id uuid NOT NULL,
    basis text NOT NULL CHECK (basis IN ('report', 'chaperone')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agency_id, id),
    FOREIGN KEY (agency_id, conversation_id) REFERENCES matrimony.chat_conversations(agency_id, id),
    FOREIGN KEY (agency_id, staff_account_id) REFERENCES matrimony.accounts(agency_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_conversations', 'chat_messages', 'chat_reports', 'chat_chaperones', 'chat_access_log']
  LOOP
    EXECUTE format('ALTER TABLE matrimony.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE matrimony.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON matrimony.%I USING (agency_id = matrimony.current_agency_id()) WITH CHECK (agency_id = matrimony.current_agency_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON matrimony.chat_conversations, matrimony.chat_messages, matrimony.chat_reports,
    matrimony.chat_chaperones, matrimony.chat_access_log TO matrimony_runtime;
GRANT UPDATE (requested_by, status, end_reason, ended_by, accepted_at, ended_at, last_message_at, requested_at)
    ON matrimony.chat_conversations TO matrimony_runtime;
GRANT UPDATE (read_at) ON matrimony.chat_messages TO matrimony_runtime;
GRANT UPDATE (resolved_at, resolved_by, resolution_note) ON matrimony.chat_reports TO matrimony_runtime;
GRANT UPDATE (removed_at, created_at, invited_by) ON matrimony.chat_chaperones TO matrimony_runtime;

-- A new message tells the other person's open pages to look again (the same channel as the inbox).
CREATE FUNCTION matrimony.chat_message_signal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  SELECT p.owner_account_id INTO target
    FROM matrimony.chat_conversations c
    JOIN matrimony.member_profiles p ON p.agency_id = c.agency_id
     AND p.id = CASE WHEN c.profile_a = NEW.sender_profile_id THEN c.profile_b ELSE c.profile_a END
   WHERE c.agency_id = NEW.agency_id AND c.id = NEW.conversation_id;
  IF target IS NOT NULL THEN
    PERFORM pg_notify('notifications', json_build_object('agency', NEW.agency_id, 'account', target)::text);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_messages_signal AFTER INSERT ON matrimony.chat_messages
    FOR EACH ROW EXECUTE FUNCTION matrimony.chat_message_signal();

-- Erasing. Run with the owner's rights because the runtime role can never delete.
CREATE FUNCTION matrimony.end_unavailable_chats(p_agency uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE n integer;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE chat_conversations c
     SET status = 'ended', end_reason = 'profile_unavailable', ended_at = now()
   WHERE c.agency_id = p_agency AND c.status <> 'ended'
     AND EXISTS (SELECT 1 FROM member_profiles p
                  WHERE p.agency_id = c.agency_id AND p.id IN (c.profile_a, c.profile_b)
                    AND p.status <> 'active');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION matrimony.erase_old_chat_messages(p_agency uuid, p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE n integer;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  DELETE FROM chat_messages m
   USING chat_conversations c
   WHERE m.agency_id = p_agency AND c.agency_id = m.agency_id AND c.id = m.conversation_id
     AND c.status = 'ended' AND c.ended_at < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION matrimony.erase_chats_of_account(p_agency uuid, p_account uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = matrimony, public AS $$
DECLARE n integer;
BEGIN
  IF p_agency IS DISTINCT FROM current_agency_id() THEN RAISE EXCEPTION 'wrong agency'; END IF;
  UPDATE chat_conversations c
     SET status = 'ended', end_reason = COALESCE(c.end_reason, 'account_deleted'),
         ended_at = COALESCE(c.ended_at, now())
   WHERE c.agency_id = p_agency
     AND (c.profile_a IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account)
       OR c.profile_b IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account));
  DELETE FROM chat_messages m
   USING chat_conversations c
   WHERE m.agency_id = p_agency AND c.agency_id = m.agency_id AND c.id = m.conversation_id
     AND (c.profile_a IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account)
       OR c.profile_b IN (SELECT id FROM member_profiles WHERE agency_id = p_agency AND owner_account_id = p_account));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION matrimony.end_unavailable_chats(uuid), matrimony.erase_old_chat_messages(uuid, timestamptz),
    matrimony.erase_chats_of_account(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION matrimony.end_unavailable_chats(uuid), matrimony.erase_old_chat_messages(uuid, timestamptz),
    matrimony.erase_chats_of_account(uuid, uuid) TO matrimony_runtime;
