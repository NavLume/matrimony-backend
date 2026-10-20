import type {
  AssignmentRecord,
  ClientListItem,
  ClientMeta,
  ClientPage,
  StaffMember,
} from '../bo/client.js';
import type { ClientDetail } from '../service/client-service.js';
import { profileResponse } from './profile-response.js';

const staffRef = (s: { id: string; displayName: string } | null) =>
  s && { id: s.id, displayName: s.displayName };

const item = (c: ClientListItem) => ({
  id: c.id,
  memberCode: c.memberCode,
  fullName: c.fullName,
  status: c.status,
  serviceMode: c.serviceMode,
  version: c.version,
  updatedAt: c.updatedAt,
  assignedAgent: staffRef(c.assignedAgent),
  districtCode: c.districtCode,
  hasPendingReview: c.hasPendingReview,
  verified: c.verified,
});

const meta = (m: ClientMeta) => ({
  serviceMode: m.serviceMode,
  assignedAgent: staffRef(m.assignedAgent),
  owner: staffRef(m.owner),
});

/** A page of clients as the API returns it. Fields are listed so nothing leaks by accident. */
export const clientPageResponse = (page: ClientPage) => ({
  items: page.items.map(item),
  next: page.next,
});

/** A client's profile, the review waiting on it, and who looks after it. */
export const clientDetailResponse = (detail: ClientDetail) => ({
  ...profileResponse(detail.state),
  client: meta(detail.meta),
});

export const staffMemberResponse = (s: StaffMember) => ({
  id: s.id,
  displayName: s.displayName,
  email: s.email,
  role: s.role,
  status: s.status,
  clientCount: s.clientCount,
});

export const staffListResponse = (staff: StaffMember[]) => ({
  staff: staff.map(staffMemberResponse),
});

export const assignmentsResponse = (records: AssignmentRecord[]) => ({
  assignments: records.map((r) => ({
    id: r.id,
    at: r.at,
    from: r.from,
    to: r.to,
    by: r.by,
    reason: r.reason,
  })),
});
