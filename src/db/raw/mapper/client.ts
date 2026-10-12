import { z } from 'zod';
import type {
  AssignmentRecord,
  ClientListItem,
  ClientMeta,
  StaffMember,
} from '../../../bo/client.js';
import { clientListRow, clientMetaRow, staffRow } from '../../entity/client.js';

export function mapClientItem(value: unknown): ClientListItem {
  const row = clientListRow.parse(value);
  return {
    id: row.id,
    memberCode: row.member_code,
    fullName: row.full_name,
    status: row.status,
    serviceMode: row.service_mode,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    position: row.position,
    assignedAgent:
      row.assigned_agent_id && row.agent_name
        ? { id: row.assigned_agent_id, displayName: row.agent_name }
        : null,
    districtCode: row.current_district_code,
    hasPendingReview: row.has_pending_review,
  };
}

export function mapClientMeta(value: unknown): ClientMeta {
  const row = clientMetaRow.parse(value);
  return {
    serviceMode: row.service_mode,
    assignedAgent:
      row.assigned_agent_id && row.agent_name
        ? { id: row.assigned_agent_id, displayName: row.agent_name }
        : null,
    owner:
      row.owner_account_id && row.owner_name
        ? { id: row.owner_account_id, displayName: row.owner_name }
        : null,
  };
}

export function mapStaff(value: unknown): StaffMember {
  const row = staffRow.parse(value);
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    clientCount: row.client_count,
  };
}

const assignmentRow = z.object({
  id: z.uuid(),
  created_at: z.date(),
  from_id: z.uuid().nullable(),
  from_name: z.string().nullable(),
  to_id: z.uuid().nullable(),
  to_name: z.string().nullable(),
  by_id: z.uuid().nullable(),
  by_name: z.string().nullable(),
  reason: z.enum(['assigned', 'handed_over', 'earlier', 'automatic']),
});

export function mapAssignment(value: unknown): AssignmentRecord {
  const row = assignmentRow.parse(value);
  const ref = (id: string | null, name: string | null) =>
    id && name ? { id, displayName: name } : null;
  return {
    id: row.id,
    at: row.created_at.toISOString(),
    from: ref(row.from_id, row.from_name),
    to: ref(row.to_id, row.to_name),
    by: ref(row.by_id, row.by_name),
    reason: row.reason,
  };
}
