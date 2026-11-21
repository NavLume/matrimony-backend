import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, settingsInputSchema } from '../src/bo/agency-settings.js';
import { followUpDue, followUpState, leadCallSchema } from '../src/bo/lead-follow-up.js';

/** A Bangladesh wall-clock time (UTC+6) as a Date. */
const bd = (local: string) => new Date(`${local}+06:00`);

void test('the limit counts office hours only (10:00 to 20:00, Bangladesh time)', () => {
  assert.deepEqual(followUpDue(bd('2026-11-21T11:00:00'), 2), bd('2026-11-21T13:00:00'));
  // Left late in the evening: the rest of the time runs from the next morning.
  assert.deepEqual(followUpDue(bd('2026-11-21T19:00:00'), 2), bd('2026-11-22T11:00:00'));
  // Left at night or before opening: counting starts at 10:00.
  assert.deepEqual(followUpDue(bd('2026-11-21T23:30:00'), 2), bd('2026-11-22T12:00:00'));
  assert.deepEqual(followUpDue(bd('2026-11-22T07:00:00'), 2), bd('2026-11-22T12:00:00'));
  // A limit longer than a day of office hours spans days.
  assert.deepEqual(followUpDue(bd('2026-11-21T10:00:00'), 24), bd('2026-11-23T14:00:00'));
  // A broken date never loops.
  assert.ok(Number.isNaN(followUpDue(new Date('nope'), 2).getTime()));
});

void test('an enquiry is waiting, overdue, then escalated after a second limit, unless someone called', () => {
  const lead = { createdAt: bd('2026-11-21T11:00:00'), firstContactAt: null, status: 'new' };
  assert.equal(followUpState(lead, 2, bd('2026-11-21T12:59:00')).state, 'waiting');
  assert.equal(followUpState(lead, 2, bd('2026-11-21T13:30:00')).state, 'overdue');
  assert.equal(followUpState(lead, 2, bd('2026-11-21T15:00:00')).state, 'escalated');
  assert.deepEqual(
    followUpState(lead, 2, bd('2026-11-21T12:00:00')).dueAt,
    bd('2026-11-21T13:00:00'),
  );
  const called = { ...lead, firstContactAt: bd('2026-11-21T11:10:00') };
  assert.deepEqual(followUpState(called, 2, bd('2026-11-22T11:00:00')), {
    state: 'contacted',
    dueAt: null,
  });
  assert.equal(
    followUpState({ ...lead, status: 'closed' }, 2, bd('2026-11-22T11:00:00')).state,
    'contacted',
  );
});

void test('a call is one of the outcomes; only "call me later" carries a time', () => {
  assert.equal(leadCallSchema.parse({ outcome: 'no_answer', note: '  ' }).note, undefined);
  assert.equal(
    leadCallSchema.parse({ outcome: 'call_later', callAgainAt: '2026-11-22T05:00:00.000Z' })
      .outcome,
    'call_later',
  );
  assert.throws(() =>
    leadCallSchema.parse({ outcome: 'interested', callAgainAt: '2026-11-22T05:00:00.000Z' }),
  );
  assert.throws(() => leadCallSchema.parse({ outcome: 'maybe' }));
  assert.throws(() => leadCallSchema.parse({ outcome: 'no_answer', note: 'x'.repeat(501) }));
});

void test('the time limit is an admin setting of 1 to 48 hours, 2 by default, kept when left out', () => {
  assert.equal(parseSettings({}).leads.followUpHours, 2);
  assert.equal(parseSettings({ leads: { followUpHours: 4 } }).leads.followUpHours, 4);
  assert.equal(parseSettings({ leads: { followUpHours: 99 } }).leads.followUpHours, 2);
  const base = {
    attention: { reviewDays: 2, unansweredDays: 5, noCandidatesDays: 3, noMeetingDays: 7 },
    messaging: { enabled: false, perMemberDaily: 3, dailyLimit: 100 },
    assignment: { mode: 'automatic' },
  };
  assert.equal(
    settingsInputSchema.parse({ ...base, leads: { followUpHours: 3 } }).leads?.followUpHours,
    3,
  );
  assert.throws(() => settingsInputSchema.parse({ ...base, leads: { followUpHours: 0 } }));
  assert.throws(() => settingsInputSchema.parse({ ...base, leads: { followUpHours: 1.5 } }));
});
