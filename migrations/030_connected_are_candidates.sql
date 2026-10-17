-- Everyone a client is connected with is also one of their candidates (15 October 2026).
--
-- The friend's rule: the candidates of a client are a superset of their connections. From now on, when a
-- connection is accepted the two profiles are released to each other (the code does it in the same
-- transaction). This adds the pairs that were accepted before. A pair that is already released stays as it
-- is, and one that was only proposed, lapsed or removed becomes released, because the agent approved the
-- request that led to the connection.

INSERT INTO matrimony.client_candidates
    (agency_id, client_profile_id, candidate_profile_id, state, met_count, unmet_count, unknown_count,
     criteria)
SELECT i.agency_id, p.client, p.candidate, 'released', 0, 0, 0, '{"forward": [], "reverse": []}'::jsonb
  FROM matrimony.interests i
  CROSS JOIN LATERAL (VALUES (i.sender_profile_id, i.recipient_profile_id),
                             (i.recipient_profile_id, i.sender_profile_id)) AS p(client, candidate)
 WHERE i.status = 'accepted'
ON CONFLICT (agency_id, client_profile_id, candidate_profile_id) DO UPDATE
   SET state = 'released', updated_at = now()
 WHERE matrimony.client_candidates.state <> 'released';
