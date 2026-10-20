import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowEvent } from '../src/bo/event.js';
import { meetingInputSchema, meetingPatchSchema } from '../src/bo/meeting.js';
import type { RawMeeting } from '../src/db/raw/repository/meeting-repository.js';
import type { MeetingUnit } from '../src/db/service/meeting-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { MeetingService } from '../src/service/meeting-service.js';
import { agency } from './fixtures.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = ID(1);
const SALMA = ID(11);
const KAMAL = ID(12);
const NASRIN = ID(13);
const A = ID(201); // Rahim, Salma
const B = ID(202); // Nusrat, Kamal (or Salma)
const OWNER_B = ID(22);
const CONNECTION = ID(100);
const NOW = new Date('2026-10-20T10:00:00Z');
const FUTURE = '2026-10-25T10:00:00+06:00';
const PAST = '2026-10-10T10:00:00+06:00';

const actor = (role: 'admin' | 'agent' | 'member', accountId: string) => ({
  agencyId: agency,
  accountId,
  role,
});
const code = (status: number, name: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === name;

function setup(options: { agentB?: string; status?: string } = {}) {
  const agentB = options.agentB ?? KAMAL;
  type P = {
    id: string;
    memberCode: string;
    fullName: string;
    assignedAgentId: string | null;
    ownerAccountId: string | null;
  };
  const profiles: Record<string, P> = {
    [A]: {
      id: A,
      memberCode: 'M1',
      fullName: 'Rahim',
      assignedAgentId: SALMA,
      ownerAccountId: null,
    },
    [B]: {
      id: B,
      memberCode: 'M2',
      fullName: 'Nusrat',
      assignedAgentId: agentB,
      ownerAccountId: OWNER_B,
    },
  };
  const state = {
    meetings: new Map<string, RawMeeting>(),
    notified: 0,
    feedback: new Map<string, unknown>(),
    events: [] as WorkflowEvent[],
    followUps: [] as Array<{ id: string; profileId: string; assignedTo: string; done: boolean }>,
  };
  const side = (p: P) => ({
    profileId: p.id,
    memberCode: p.memberCode,
    fullName: p.fullName,
    agentId: p.assignedAgentId,
    ownerId: p.ownerAccountId,
  });
  const unit = {
    interest: async () => ({
      id: CONNECTION,
      status: options.status ?? 'accepted',
      senderId: A,
      recipientId: B,
    }),
    profileById: async (_a: string, id: string) => profiles[id] ?? null,
    ownProfile: async (_a: string, account: string) =>
      account === OWNER_B ? (profiles[B] ?? null) : null,
    insertMeeting: async (_a: string, m: Record<string, unknown>) => {
      state.meetings.set(m.id as string, {
        id: m.id as string,
        connectionId: m.interestId as string,
        scheduledAt: m.scheduledAt as string,
        kind: m.kind as never,
        place: (m.place as string | null) ?? null,
        note: (m.note as string | null) ?? null,
        status: m.status as never,
        proposedSide: (m.proposedSide as string | null) ?? null,
        createdBy: m.createdBy as string,
        past: false,
        sides: [side(profiles[A]!), side(profiles[B]!)],
      });
    },
    meeting: async (_a: string, id: string) => state.meetings.get(id) ?? null,
    updateMeeting: async (_a: string, id: string, patch: Record<string, unknown>) => {
      const meeting = state.meetings.get(id);
      if (!meeting || (meeting.status !== 'proposed' && meeting.status !== 'scheduled'))
        return false;
      for (const [key, value] of Object.entries(patch))
        if (value !== undefined) (meeting as unknown as Record<string, unknown>)[key] = value;
      return true;
    },
    feedbackFor: async () => state.feedback as never,
    saveFeedback: async (_a: string, meetingId: string, profileId: string, input: unknown) =>
      void state.feedback.set(`${meetingId}:${profileId}`, input),
    notifyMeeting: async () => void (state.notified += 1),
    appendEvent: async (event: WorkflowEvent) => void state.events.push(event),
    insertFollowUp: async (_a: string, f: { id: string; profileId: string; assignedTo: string }) =>
      void state.followUps.push({ ...f, done: false }),
    followUpsOfProfile: async () => state.followUps as never,
    followUp: async (_a: string, id: string) => state.followUps.find((f) => f.id === id) ?? null,
    markFollowUpDone: async (_a: string, id: string) => {
      const found = state.followUps.find((f) => f.id === id);
      if (found) found.done = true;
    },
  };
  const db = {
    inTransaction: async <T>(_agency: string, work: (u: MeetingUnit) => Promise<T>) =>
      work(unit as unknown as MeetingUnit),
  };
  let n = 700;
  const service = new MeetingService(
    db,
    () => NOW,
    () => ID(n++),
  );
  return { state, service };
}

const input = (when = FUTURE) =>
  meetingInputSchema.parse({ scheduledAt: when, kind: 'first_meeting' });

await test('an admin, or the same agent for both clients, sets a meeting at once; otherwise the other side confirms', async () => {
  const byAdmin = setup();
  const m1 = await byAdmin.service.schedule(actor('admin', ADMIN), CONNECTION, input(), 'r');
  assert.equal(m1.status, 'scheduled');

  const sameAgent = setup({ agentB: SALMA });
  const m2 = await sameAgent.service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  assert.equal(m2.status, 'scheduled');

  const different = setup();
  const m3 = await different.service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  assert.equal(m3.status, 'proposed');
  assert.equal(m3.canRespond, false);
  assert.equal(different.state.notified, 1);
  assert.equal(different.state.events[0]?.type, 'meeting.scheduled');
});

await test('a meeting needs an accepted proposal, a staff member of one side, and a time that is not past', async () => {
  const notAccepted = setup({ status: 'pending' });
  await assert.rejects(
    () => notAccepted.service.schedule(actor('admin', ADMIN), CONNECTION, input(), 'r'),
    code(409, 'CONNECTION_NOT_ACCEPTED'),
  );
  const stranger = setup();
  await assert.rejects(
    () => stranger.service.schedule(actor('agent', NASRIN), CONNECTION, input(), 'r'),
    code(404, 'CONNECTION_NOT_FOUND'),
  );
  await assert.rejects(
    () => stranger.service.schedule(actor('member', OWNER_B), CONNECTION, input(), 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
  await assert.rejects(
    () => stranger.service.schedule(actor('admin', ADMIN), CONNECTION, input(PAST), 'r'),
    code(400, 'INVALID_REQUEST'),
  );
});

await test('only the side that did not propose confirms, and then it is scheduled', async () => {
  const { service, state } = setup();
  const proposed = await service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  await assert.rejects(
    () => service.confirm(actor('agent', SALMA), proposed.id, 'r'),
    code(403, 'MEETING_OWN_PROPOSAL'),
  );
  await assert.rejects(
    () => service.confirm(actor('agent', NASRIN), proposed.id, 'r'),
    code(404, 'MEETING_NOT_FOUND'),
  );
  const confirmed = await service.confirm(actor('agent', KAMAL), proposed.id, 'r');
  assert.equal(confirmed.status, 'scheduled');
  assert.equal(state.events.at(-1)?.type, 'meeting.confirmed');
  await assert.rejects(
    () => service.confirm(actor('agent', KAMAL), proposed.id, 'r'),
    code(409, 'MEETING_NOT_PROPOSED'),
  );
});

await test('a client who signs in can confirm what the other side proposed, but not their own proposal', async () => {
  const { service } = setup();
  const proposed = await service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  await service.confirmAsClient(actor('member', OWNER_B), proposed.id, 'r');
  await assert.rejects(
    () => service.confirmAsClient(actor('member', OWNER_B), proposed.id, 'r'),
    code(409, 'MEETING_NOT_PROPOSED'),
  );

  const mine = setup();
  const own = await mine.service.schedule(actor('agent', KAMAL), CONNECTION, input(), 'r');
  await assert.rejects(
    () => mine.service.confirmAsClient(actor('member', OWNER_B), own.id, 'r'),
    code(403, 'MEETING_OWN_PROPOSAL'),
  );
  await assert.rejects(
    () => mine.service.confirmAsClient(actor('agent', SALMA), own.id, 'r'),
    code(403, 'ROLE_FORBIDDEN'),
  );
});

await test('a changed time or place goes back to the other side, but an admin change stands', async () => {
  const { service } = setup({ agentB: SALMA });
  // Same agent: scheduled at once, and a later change is also theirs to make.
  const made = await service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  const changed = await service.change(
    actor('agent', SALMA),
    made.id,
    meetingPatchSchema.parse({ place: 'Cafe' }),
    'r',
  );
  assert.equal(changed.place, 'Cafe');

  const two = setup();
  const proposed = await two.service.schedule(actor('admin', ADMIN), CONNECTION, input(), 'r');
  const byAgent = await two.service.change(
    actor('agent', SALMA),
    proposed.id,
    meetingPatchSchema.parse({ place: 'Home' }),
    'r',
  );
  assert.equal(byAgent.status, 'proposed');
  assert.equal(byAgent.canRespond, false);
  const byAdmin = await two.service.change(
    actor('admin', ADMIN),
    proposed.id,
    meetingPatchSchema.parse({ place: 'Office' }),
    'r',
  );
  assert.equal(byAdmin.status, 'scheduled');
});

await test('a meeting is marked done only when it was confirmed and its time has come; cancelled ones are closed', async () => {
  const { service, state } = setup();
  const proposed = await service.schedule(actor('agent', SALMA), CONNECTION, input(), 'r');
  await assert.rejects(
    () =>
      service.change(
        actor('agent', SALMA),
        proposed.id,
        meetingPatchSchema.parse({ status: 'done' }),
        'r',
      ),
    code(409, 'MEETING_NOT_CONFIRMED'),
  );
  await service.confirm(actor('agent', KAMAL), proposed.id, 'r');
  await assert.rejects(
    () =>
      service.change(
        actor('agent', SALMA),
        proposed.id,
        meetingPatchSchema.parse({ status: 'done' }),
        'r',
      ),
    code(409, 'MEETING_NOT_HELD_YET'),
  );
  // Time passes.
  state.meetings.get(proposed.id)!.scheduledAt = '2026-10-19T10:00:00+06:00';
  const done = await service.change(
    actor('agent', SALMA),
    proposed.id,
    meetingPatchSchema.parse({ status: 'done' }),
    'r',
  );
  assert.equal(done.status, 'done');
  await assert.rejects(
    () =>
      service.change(
        actor('agent', SALMA),
        proposed.id,
        meetingPatchSchema.parse({ status: 'cancelled' }),
        'r',
      ),
    code(409, 'MEETING_CLOSED'),
  );
});

await test('feedback is for a finished meeting, recorded by the staff of that side only, and never shown to the other side', async () => {
  const { service, state } = setup();
  const proposed = await service.schedule(actor('admin', ADMIN), CONNECTION, input(), 'r');
  await assert.rejects(
    () =>
      service.recordFeedback(actor('agent', SALMA), proposed.id, A, { verdict: 'interested' }, 'r'),
    code(409, 'MEETING_NOT_DONE'),
  );
  state.meetings.get(proposed.id)!.scheduledAt = '2026-10-19T10:00:00+06:00';
  await service.change(
    actor('admin', ADMIN),
    proposed.id,
    meetingPatchSchema.parse({ status: 'done' }),
    'r',
  );
  await assert.rejects(
    () =>
      service.recordFeedback(actor('agent', SALMA), proposed.id, B, { verdict: 'interested' }, 'r'),
    code(404, 'MEETING_NOT_FOUND'),
  );
  const row = await service.recordFeedback(
    actor('agent', SALMA),
    proposed.id,
    A,
    { verdict: 'undecided', note: 'Needs time' },
    'r',
  );
  const salmasSide = row.people.find((p) => p.profileId === A)!;
  const otherSide = row.people.find((p) => p.profileId === B)!;
  assert.equal(salmasSide.feedback?.verdict, 'undecided');
  assert.equal(otherSide.feedback, null);
  const kamalsView = await service.recordFeedback(
    actor('agent', KAMAL),
    proposed.id,
    B,
    { verdict: 'interested' },
    'r',
  );
  assert.equal(kamalsView.people.find((p) => p.profileId === A)?.feedback, null);
});

await test("a follow-up belongs to the client's agent, only staff of that client add or finish it, once", async () => {
  const { service, state } = setup();
  const added = await service.addFollowUp(
    actor('admin', ADMIN),
    A,
    { dueOn: '2026-10-22', text: 'Call both families' },
    'r',
  );
  assert.equal(added[0]?.assignedTo, SALMA);
  await assert.rejects(
    () => service.addFollowUp(actor('agent', KAMAL), A, { dueOn: '2026-10-22', text: 'x' }, 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await assert.rejects(
    () => service.addFollowUp(actor('agent', SALMA), A, { dueOn: 'not a date', text: 'x' }, 'r'),
    code(400, 'INVALID_REQUEST'),
  );
  const id = state.followUps[0]!.id;
  await assert.rejects(
    () => service.completeFollowUp(actor('agent', KAMAL), id, 'r'),
    code(404, 'PROFILE_NOT_FOUND'),
  );
  await service.completeFollowUp(actor('agent', SALMA), id, 'r');
  await assert.rejects(
    () => service.completeFollowUp(actor('agent', SALMA), id, 'r'),
    code(409, 'FOLLOW_UP_DONE'),
  );
  await assert.rejects(
    () => service.completeFollowUp(actor('agent', SALMA), ID(999), 'r'),
    code(404, 'FOLLOW_UP_NOT_FOUND'),
  );
});
