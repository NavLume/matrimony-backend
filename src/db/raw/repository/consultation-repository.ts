import type { Transaction } from '../../config/database.js';
import type {
  Intent,
  HeardFrom,
  LeadSource,
  StaffLead,
  StaffLeadQuery,
  StartMode,
} from '../../../bo/consultation.js';
import type { CallOutcome, LeadCall, LeadCallInput } from '../../../bo/lead-follow-up.js';

type Row = Record<string, unknown>;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** An open enquiry the visitor may continue (same number, not closed, recent). */
export interface OpenLead {
  id: string;
  reference: string;
  agentId: string | null;
  callbackRequested: boolean;
  visitRequested: boolean;
  /** The number was proved at least once (false: only a code asked for, or an unverified call request). */
  verified: boolean;
}

export interface NewConsultation {
  reference: string;
  name: string;
  phone: string;
  profileId: string | null;
  source: LeadSource;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  firstSeenAt: string | null;
  clickId: 'facebook' | 'google' | null;
  office: string | null;
  agentId: string | null;
  intent: Intent;
  heardFrom: HeardFrom | null;
  mode: StartMode;
  /** A ticket's hash for a proved number; null otherwise. */
  ticketHash: string | null;
}

const STAFF_SELECT = `SELECT l.id, l.kind, l.reference, l.name, l.phone_e164, l.status, l.note, l.created_at,
       l.last_verified_at, l.visits, l.office, l.callback_requested_at, l.call_clicked_at,
       l.assigned_agent_id, ag.display_name AS agent_name, hb.display_name AS handled_by_name, l.handled_at,
       l.intent, l.for_whom, l.heard_from, l.verified_at, l.visit_requested_at, l.visit_time, l.whatsapp_opened_at,
       l.source, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.referrer_host, l.landing_path,
       l.first_seen_at, l.click_id, l.code_sent_at, l.profile_id, m.member_code,
       l.client_profile_id, l.linked_at, l.link_method, cp.member_code AS client_code,
       cp.full_name AS client_name, cp.created_at AS client_created_at, lb.display_name AS linked_by_name,
       l.first_contact_at,
       (SELECT coalesce(json_agg(json_build_object(
                 'id', c.id, 'outcome', c.outcome, 'note', c.note, 'callAgainAt', c.call_again_at,
                 'calledBy', ca.display_name, 'calledAt', c.called_at) ORDER BY c.called_at DESC), '[]'::json)
          FROM (SELECT * FROM matrimony.lead_calls c0
                 WHERE c0.agency_id = l.agency_id AND c0.lead_id = l.id
                 ORDER BY c0.called_at DESC LIMIT 20) c
          LEFT JOIN matrimony.accounts ca ON ca.agency_id = c.agency_id AND ca.id = c.called_by) AS calls,
       CASE WHEN l.client_profile_id IS NULL THEN
         (SELECT count(DISTINCT pp.id)::int
            FROM matrimony.member_profiles pp
            LEFT JOIN matrimony.accounts pa ON pa.agency_id = pp.agency_id AND pa.id = pp.owner_account_id
            LEFT JOIN matrimony.profile_contacts pc ON pc.agency_id = pp.agency_id AND pc.profile_id = pp.id
           WHERE pp.agency_id = l.agency_id AND pp.erased_at IS NULL
             AND (pa.phone_e164 = l.phone_e164 OR pc.phone_e164 = l.phone_e164))
       ELSE 0 END AS phone_matches
  FROM matrimony.website_leads l
  LEFT JOIN matrimony.accounts ag ON ag.agency_id = l.agency_id AND ag.id = l.assigned_agent_id
  LEFT JOIN matrimony.accounts hb ON hb.agency_id = l.agency_id AND hb.id = l.handled_by
  LEFT JOIN matrimony.member_profiles m ON m.agency_id = l.agency_id AND m.id = l.profile_id
  LEFT JOIN matrimony.member_profiles cp ON cp.agency_id = l.agency_id AND cp.id = l.client_profile_id
  LEFT JOIN matrimony.accounts lb ON lb.agency_id = l.agency_id AND lb.id = l.linked_by`;

/**
 * Every number a client can be reached on, for the agency in $1: the client's own login number and the contact number
 * on the profile. Erased profiles are left out.
 */
const PROFILE_PHONES = `SELECT p.id AS profile_id, a.phone_e164 AS phone
    FROM matrimony.member_profiles p
    JOIN matrimony.accounts a ON a.agency_id = p.agency_id AND a.id = p.owner_account_id
   WHERE p.agency_id = $1 AND p.erased_at IS NULL AND a.phone_e164 IS NOT NULL
  UNION
  SELECT c.profile_id, c.phone_e164
    FROM matrimony.profile_contacts c
    JOIN matrimony.member_profiles p ON p.agency_id = c.agency_id AND p.id = c.profile_id
   WHERE c.agency_id = $1 AND p.erased_at IS NULL AND c.phone_e164 IS NOT NULL`;

const staffLead = (row: Row): StaffLead => ({
  id: row.id as string,
  kind: row.kind as StaffLead['kind'],
  reference: text(row.reference),
  name: row.name as string,
  phone: row.phone_e164 as string,
  status: row.status as StaffLead['status'],
  note: text(row.note),
  createdAt: (row.created_at as Date).toISOString(),
  lastVerifiedAt: iso(row.last_verified_at),
  visits: row.visits as number,
  office: text(row.office),
  intent: text(row.intent) as StaffLead['intent'],
  forWhom: text(row.for_whom) as StaffLead['forWhom'],
  heardFrom: text(row.heard_from) as StaffLead['heardFrom'],
  verifiedAt: iso(row.verified_at),
  codeSentAt: iso(row.code_sent_at),
  callbackRequestedAt: iso(row.callback_requested_at),
  callClickedAt: iso(row.call_clicked_at),
  visitRequestedAt: iso(row.visit_requested_at),
  visitTime: text(row.visit_time) as StaffLead['visitTime'],
  whatsappOpenedAt: iso(row.whatsapp_opened_at),
  adviser: row.assigned_agent_id
    ? { id: row.assigned_agent_id as string, name: (row.agent_name as string | null) ?? '' }
    : null,
  handledBy: text(row.handled_by_name),
  handledAt: iso(row.handled_at),
  origin: {
    source: text(row.source) as LeadSource | null,
    utmSource: text(row.utm_source),
    utmMedium: text(row.utm_medium),
    utmCampaign: text(row.utm_campaign),
    utmContent: text(row.utm_content),
    referrerHost: text(row.referrer_host),
    landingPath: text(row.landing_path),
    firstSeenAt: iso(row.first_seen_at),
    clickId: text(row.click_id) as StaffLead['origin']['clickId'],
  },
  about: row.profile_id
    ? { profileId: row.profile_id as string, memberCode: row.member_code as string }
    : null,
  client: row.client_profile_id
    ? {
        profileId: row.client_profile_id as string,
        memberCode: row.client_code as string,
        name: text(row.client_name),
        createdAt: (row.client_created_at as Date).toISOString(),
        linkedAt: (row.linked_at as Date).toISOString(),
        method: row.link_method as 'auto' | 'staff',
        linkedBy: text(row.linked_by_name),
      }
    : null,
  phoneMatches: (row.phone_matches as number | null) ?? 0,
  firstContactAt: iso(row.first_contact_at),
  // Filled in by the service, which knows the agency's time limit.
  followUp: { state: 'contacted', dueAt: null },
  calls: ((row.calls as RawCall[] | null) ?? []).map(toCall),
});

interface RawCall {
  id: string;
  outcome: CallOutcome;
  note: string | null;
  callAgainAt: string | null;
  calledBy: string | null;
  calledAt: string;
}
const toCall = (call: RawCall): LeadCall => ({
  id: call.id,
  outcome: call.outcome,
  note: call.note,
  callAgainAt: call.callAgainAt ? new Date(call.callAgainAt).toISOString() : null,
  calledBy: call.calledBy,
  calledAt: new Date(call.calledAt).toISOString(),
});

/** An enquiry nobody has tried to call yet, for the follow-up round. */
export interface WaitingLead {
  id: string;
  reference: string;
  agentId: string | null;
  createdAt: Date;
  reminded: boolean;
  escalated: boolean;
}

/** Talk to an adviser: the enquiries a visitor leaves, the adviser chosen for them, and the staff list. */
export class ConsultationRepository {
  /** The agency's public content and settings, unlocked (read on every enquiry). */
  async agency(
    tx: Transaction,
    agencyId: string,
  ): Promise<{ publicConfig: unknown; settings: unknown }> {
    const result = await tx.query(
      `SELECT public_config, settings FROM matrimony.agencies WHERE id = $1`,
      [agencyId],
    );
    const row = result.rows[0] as Row | undefined;
    return { publicConfig: row?.public_config, settings: row?.settings };
  }

  /** The profile behind a showcase card, or null when the card is gone. */
  async profileOfRef(tx: Transaction, agencyId: string, ref: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT s.profile_id FROM matrimony.website_showcase s
        WHERE s.agency_id = $1 AND s.public_ref = $2`,
      [agencyId, ref],
    );
    return ((result.rows[0] as Row | undefined)?.profile_id as string | undefined) ?? null;
  }

  /**
   * The newest open enquiry for this number in the last `days` days, locked so two quick submissions from one
   * person cannot both create a new one. Two submissions that both find none can still race; the second then
   * only adds a second row, which staff see as two visits by the same number.
   */
  async openByPhone(
    tx: Transaction,
    agencyId: string,
    phone: string,
    days: number,
  ): Promise<OpenLead | null> {
    const result = await tx.query(
      `SELECT id, reference, assigned_agent_id, callback_requested_at, visit_requested_at, verified_at
         FROM matrimony.website_leads
        WHERE agency_id = $1 AND phone_e164 = $2 AND kind = 'consultation' AND status <> 'closed'
          AND created_at > now() - make_interval(days => $3::int)
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [agencyId, phone, days],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      reference: row.reference as string,
      agentId: text(row.assigned_agent_id),
      callbackRequested: row.callback_requested_at !== null,
      visitRequested: row.visit_requested_at !== null,
      verified: row.verified_at !== null,
    };
  }

  /**
   * The agent who follows a new enquiry up: the active agent given the fewest enquiries in the last 30 days, then
   * the earliest account. Null when the agency has no active agent. The visitor is never told who it is.
   */
  async chooseAdviser(tx: Transaction, agencyId: string): Promise<string | null> {
    const result = await tx.query(
      `SELECT a.id
         FROM matrimony.accounts a
        WHERE a.agency_id = $1 AND a.role = 'agent' AND a.status = 'active'
        ORDER BY (SELECT count(*) FROM matrimony.website_leads l
                   WHERE l.agency_id = a.agency_id AND l.assigned_agent_id = a.id
                     AND l.created_at > now() - interval '30 days'),
                 a.created_at, a.id
        LIMIT 1`,
      [agencyId],
    );
    return ((result.rows[0] as Row | undefined)?.id as string | undefined) ?? null;
  }

  /** Whether the account is still an active agent or admin (an enquiry keeps its agent only while they are). */
  async isActiveStaff(tx: Transaction, agencyId: string, accountId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.accounts
        WHERE agency_id = $1 AND id = $2 AND role IN ('agent', 'admin') AND status = 'active'`,
      [agencyId, accountId],
    );
    return result.rowCount === 1;
  }

  /** Stores a new enquiry. Null when the reference was taken (the caller draws another). */
  async insert(tx: Transaction, agencyId: string, lead: NewConsultation): Promise<string | null> {
    const result = await tx.query(
      `INSERT INTO matrimony.website_leads
         (agency_id, kind, reference, name, phone_e164, profile_id, source, utm_source, utm_medium, utm_campaign,
          utm_content, referrer_host, landing_path, first_seen_at, office, assigned_agent_id, ticket_hash, intent,
          click_id, last_verified_at, verified_at, callback_requested_at, code_sent_at, heard_from)
       VALUES ($1, 'consultation', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               CASE WHEN $19::text = 'verified' THEN now() END,
               CASE WHEN $19::text = 'verified' THEN now() END,
               CASE WHEN $19::text = 'callback' THEN now() END,
               CASE WHEN $19::text = 'code' THEN now() END,
               $20)
       ON CONFLICT (agency_id, reference) WHERE reference IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        agencyId,
        lead.reference,
        lead.name,
        lead.phone,
        lead.profileId,
        lead.source,
        lead.utmSource,
        lead.utmMedium,
        lead.utmCampaign,
        lead.utmContent,
        lead.referrerHost,
        lead.landingPath,
        lead.firstSeenAt,
        lead.office,
        lead.agentId,
        lead.ticketHash,
        lead.intent,
        lead.clickId,
        lead.mode,
        lead.heardFrom,
      ],
    );
    return ((result.rows[0] as Row | undefined)?.id as string | undefined) ?? null;
  }

  /**
   * The person proved the number: a new ticket and an adviser if it had none. One more visit when it was proved
   * before (a first proof after only asking for a code is the same visit).
   */
  async revisit(
    tx: Transaction,
    agencyId: string,
    id: string,
    ticketHash: string,
    agentId: string | null,
  ) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET ticket_hash = $3,
              visits = visits + CASE WHEN verified_at IS NULL THEN 0 ELSE 1 END,
              last_verified_at = now(),
              verified_at = coalesce(verified_at, now()),
              assigned_agent_id = coalesce($4, assigned_agent_id)
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, ticketHash, agentId],
    );
  }

  /** A code was asked for again on an open enquiry. */
  async markCodeSent(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET code_sent_at = now() WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
  }

  /** The enquiry a visitor's browser holds the ticket for, locked. */
  async byTicket(
    tx: Transaction,
    agencyId: string,
    reference: string,
    ticketHash: string,
  ): Promise<{
    id: string;
    agentId: string | null;
    callbackRequested: boolean;
    called: boolean;
    visitRequested: boolean;
  } | null> {
    const result = await tx.query(
      `SELECT id, assigned_agent_id, callback_requested_at, call_clicked_at, visit_requested_at
         FROM matrimony.website_leads
        WHERE agency_id = $1 AND reference = $2 AND ticket_hash = $3
        FOR UPDATE`,
      [agencyId, reference, ticketHash],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      agentId: text(row.assigned_agent_id),
      callbackRequested: row.callback_requested_at !== null,
      called: row.call_clicked_at !== null,
      visitRequested: row.visit_requested_at !== null,
    };
  }

  async markCallback(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET callback_requested_at = now()
        WHERE agency_id = $1 AND id = $2 AND callback_requested_at IS NULL`,
      [agencyId, id],
    );
  }

  /**
   * An unverified call request for a number that already has an open enquiry: a call asked for, and one more visit
   * unless the enquiry so far was only a code asked for in this same visit.
   */
  async requestAgain(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET visits = visits + CASE
                WHEN verified_at IS NULL AND callback_requested_at IS NULL THEN 0 ELSE 1 END,
              callback_requested_at = coalesce(callback_requested_at, now())
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
  }

  async markVisit(tx: Transaction, agencyId: string, id: string, time: string) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET visit_requested_at = coalesce(visit_requested_at, now()), visit_time = $3
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, time],
    );
  }

  async markWhatsapp(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET whatsapp_opened_at = now()
        WHERE agency_id = $1 AND id = $2 AND whatsapp_opened_at IS NULL`,
      [agencyId, id],
    );
  }

  async setForWhom(tx: Transaction, agencyId: string, id: string, forWhom: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET for_whom = $3 WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, forWhom],
    );
  }

  async markCalled(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET call_clicked_at = now()
        WHERE agency_id = $1 AND id = $2 AND call_clicked_at IS NULL`,
      [agencyId, id],
    );
  }

  /** The active admins, who are told when an enquiry has no adviser. */
  async adminIds(tx: Transaction, agencyId: string): Promise<string[]> {
    const result = await tx.query(
      `SELECT id FROM matrimony.accounts WHERE agency_id = $1 AND role = 'admin' AND status = 'active'`,
      [agencyId],
    );
    return (result.rows as Row[]).map((row) => row.id as string);
  }

  /** An inbox line for a staff member. `what` carries the reference only (no name, no number). */
  async notify(
    tx: Transaction,
    agencyId: string,
    recipientId: string,
    template: 'lead.new' | 'lead.callback' | 'lead.overdue',
    reference: string,
  ) {
    await tx.query(
      `INSERT INTO matrimony.notifications (agency_id, recipient_account_id, event_key, template_key, payload)
       VALUES ($1, $2, $3 || ':' || gen_random_uuid()::text, $3, jsonb_build_object('what', $4::text))`,
      [agencyId, recipientId, template, reference],
    );
  }

  // ---- staff ----------------------------------------------------------------------------------------

  /**
   * Enquiries for staff, newest first: an admin reads them all (`agentId` null); an agent only those given to them.
   * The search matches the reference, the number's digits or the name.
   */
  async list(
    tx: Transaction,
    agencyId: string,
    filter: StaffLeadQuery & { agentId: string | null },
    limit: number,
  ): Promise<StaffLead[]> {
    const q = filter.q?.trim() || null;
    const digits = q ? q.replace(/\D/g, '') : '';
    const result = await tx.query(
      `${STAFF_SELECT}
        WHERE l.agency_id = $1
          AND ($2::uuid IS NULL OR l.assigned_agent_id = $2::uuid)
          AND ($3::text IS NULL OR l.status = $3::text)
          AND ($4::text IS NULL OR l.source = $4::text)
          AND ($5::text IS NULL
               OR upper(l.reference) = upper($5::text)
               OR l.name ILIKE '%' || replace(replace(replace($5::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
               OR (length($6::text) >= 4 AND l.phone_e164 LIKE '%' || $6::text || '%'))
          AND ($8::text IS NULL OR l.utm_campaign = $8::text)
        ORDER BY (l.status = 'new') DESC,
                 ((l.callback_requested_at IS NOT NULL OR l.visit_requested_at IS NOT NULL)
                   AND l.status = 'new') DESC,
                 coalesce(l.last_verified_at, l.created_at) DESC, l.id
        LIMIT $7`,
      [
        agencyId,
        filter.agentId,
        filter.status ?? null,
        filter.source ?? null,
        q,
        digits,
        limit,
        filter.campaign || null,
      ],
    );
    return (result.rows as Row[]).map(staffLead);
  }

  /**
   * Joins enquiries not yet linked to the client with the same number, when exactly one client has it. A number
   * several clients share (a parent registering two children) is left for staff, and so is an enquiry whose link an
   * admin undid. Run before staff read enquiries or a client's enquiries; returns how many were linked.
   */
  async linkPending(
    tx: Transaction,
    agencyId: string,
  ): Promise<{ id: string; profileId: string }[]> {
    const result = await tx.query(
      `WITH phones AS (${PROFILE_PHONES}),
            single AS (
              SELECT phone, (array_agg(DISTINCT profile_id))[1] AS profile_id
                FROM phones GROUP BY phone HAVING count(DISTINCT profile_id) = 1)
       UPDATE matrimony.website_leads l
          SET client_profile_id = s.profile_id, linked_at = now(), link_method = 'auto'
         FROM single s
        WHERE l.agency_id = $1 AND l.client_profile_id IS NULL AND NOT l.auto_link_blocked
          AND l.phone_e164 = s.phone
       RETURNING l.id, l.client_profile_id`,
      [agencyId],
    );
    return (result.rows as Row[]).map((row) => ({
      id: row.id as string,
      profileId: row.client_profile_id as string,
    }));
  }

  /** The client with this member code (not erased), or null. */
  async profileByCode(
    tx: Transaction,
    agencyId: string,
    memberCode: string,
  ): Promise<{ id: string; agentId: string | null } | null> {
    const result = await tx.query(
      `SELECT id, assigned_agent_id FROM matrimony.member_profiles
        WHERE agency_id = $1 AND upper(member_code) = upper($2) AND erased_at IS NULL`,
      [agencyId, memberCode],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? { id: row.id as string, agentId: text(row.assigned_agent_id) } : null;
  }

  /** The agent who looks after a client, and whether the client exists. */
  async clientAgent(
    tx: Transaction,
    agencyId: string,
    profileId: string,
  ): Promise<{ agentId: string | null } | null> {
    const result = await tx.query(
      `SELECT assigned_agent_id FROM matrimony.member_profiles WHERE agency_id = $1 AND id = $2`,
      [agencyId, profileId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? { agentId: text(row.assigned_agent_id) } : null;
  }

  /** Staff link an enquiry to a client by hand. */
  async linkClient(tx: Transaction, agencyId: string, id: string, profileId: string, by: string) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET client_profile_id = $3, linked_at = now(), link_method = 'staff', linked_by = $4
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, profileId, by],
    );
  }

  /** An admin undoes a link; the number is then never linked automatically again. */
  async unlinkClient(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET client_profile_id = NULL, linked_at = NULL, link_method = NULL, linked_by = NULL,
              auto_link_blocked = true
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
  }

  /** The enquiries linked to one client, oldest first. */
  async ofClient(tx: Transaction, agencyId: string, profileId: string): Promise<StaffLead[]> {
    const result = await tx.query(
      `${STAFF_SELECT} WHERE l.agency_id = $1 AND l.client_profile_id = $2 ORDER BY l.created_at, l.id`,
      [agencyId, profileId],
    );
    return (result.rows as Row[]).map(staffLead);
  }

  async one(tx: Transaction, agencyId: string, id: string): Promise<StaffLead | null> {
    const result = await tx.query(`${STAFF_SELECT} WHERE l.agency_id = $1 AND l.id = $2`, [
      agencyId,
      id,
    ]);
    const row = result.rows[0] as Row | undefined;
    return row ? staffLead(row) : null;
  }

  async setStatus(
    tx: Transaction,
    agencyId: string,
    id: string,
    change: { status: string; note: string | null; by: string },
  ) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET status = $3, note = $4, handled_by = $5, handled_at = now(),
              -- Moving an enquiry on from "new" counts as contacting it.
              first_contact_at = CASE WHEN $3::text <> 'new' THEN coalesce(first_contact_at, now())
                                      ELSE first_contact_at END
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, change.status, change.note, change.by],
    );
  }

  /**
   * Writes down a call. It is the first contact if none was recorded; a call that reached the person (anything but no
   * answer) also moves a new enquiry to "contacted".
   */
  async addCall(tx: Transaction, agencyId: string, id: string, call: LeadCallInput, by: string) {
    await tx.query(
      `INSERT INTO matrimony.lead_calls (agency_id, lead_id, outcome, note, call_again_at, called_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agencyId, id, call.outcome, call.note ?? null, call.callAgainAt ?? null, by],
    );
    await tx.query(
      `UPDATE matrimony.website_leads
          SET first_contact_at = coalesce(first_contact_at, now()),
              status = CASE WHEN status = 'new' AND $3::text <> 'no_answer' THEN 'contacted' ELSE status END,
              handled_by = CASE WHEN status = 'new' AND $3::text <> 'no_answer' THEN $4::uuid ELSE handled_by END,
              handled_at = CASE WHEN status = 'new' AND $3::text <> 'no_answer' THEN now() ELSE handled_at END
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, call.outcome, by],
    );
  }

  /** Enquiries of the last 30 days nobody has tried to call, still to be reminded or escalated. */
  async waitingForCall(tx: Transaction, agencyId: string, limit: number): Promise<WaitingLead[]> {
    const result = await tx.query(
      `SELECT id, reference, assigned_agent_id, created_at,
              followup_reminded_at IS NOT NULL AS reminded, followup_escalated_at IS NOT NULL AS escalated
         FROM matrimony.website_leads
        WHERE agency_id = $1 AND kind = 'consultation' AND status = 'new' AND first_contact_at IS NULL
          AND (followup_reminded_at IS NULL OR followup_escalated_at IS NULL)
          AND created_at > now() - interval '30 days'
        ORDER BY created_at
        LIMIT $2`,
      [agencyId, limit],
    );
    return (result.rows as Row[]).map((row) => ({
      id: row.id as string,
      reference: row.reference as string,
      agentId: text(row.assigned_agent_id),
      createdAt: row.created_at as Date,
      reminded: row.reminded as boolean,
      escalated: row.escalated as boolean,
    }));
  }

  async markReminded(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET followup_reminded_at = coalesce(followup_reminded_at, now())
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
  }

  async markEscalated(tx: Transaction, agencyId: string, id: string) {
    await tx.query(
      `UPDATE matrimony.website_leads
          SET followup_reminded_at = coalesce(followup_reminded_at, now()),
              followup_escalated_at = coalesce(followup_escalated_at, now())
        WHERE agency_id = $1 AND id = $2`,
      [agencyId, id],
    );
  }

  async assign(tx: Transaction, agencyId: string, id: string, agentId: string) {
    await tx.query(
      `UPDATE matrimony.website_leads SET assigned_agent_id = $3 WHERE agency_id = $1 AND id = $2`,
      [agencyId, id, agentId],
    );
  }

  /** Whether the account is an active agent of the agency. */
  async isActiveAgent(tx: Transaction, agencyId: string, accountId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM matrimony.accounts WHERE agency_id = $1 AND id = $2 AND role = 'agent' AND status = 'active'`,
      [agencyId, accountId],
    );
    return result.rowCount === 1;
  }
}
