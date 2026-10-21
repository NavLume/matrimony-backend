import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, settingsInputSchema } from '../src/bo/agency-settings.js';
import type { AgencySettings } from '../src/bo/agency-settings.js';
import type { WorkflowEvent } from '../src/bo/event.js';
import type { SettingsUnit } from '../src/db/service/settings-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import type { ProfileActor } from '../src/service/profile-service.js';
import { SettingsService } from '../src/service/settings-service.js';
import { agency } from './fixtures.js';

const actor = (role: ProfileActor['role']): ProfileActor => ({
  agencyId: agency,
  accountId: '00000000-0000-4000-8000-000000000001',
  role,
});

const input = {
  attention: { reviewDays: 1, unansweredDays: 3, noCandidatesDays: 2, noMeetingDays: 5 },
};

function setup() {
  let stored: AgencySettings = parseSettings({});
  const events: WorkflowEvent[] = [];
  const unit: SettingsUnit = {
    get: async () => stored,
    save: async (_a, value) => void (stored = value),
    appendEvent: async (event) => void events.push(event),
  };
  return {
    service: new SettingsService({ inTransaction: async (_a, work) => work(unit) }),
    events,
    stored: () => stored,
  };
}

await test('missing or invalid values read as the defaults, so a bad value never breaks a page', () => {
  assert.deepEqual(parseSettings(undefined).attention, {
    reviewDays: 2,
    unansweredDays: 5,
    noCandidatesDays: 3,
    noMeetingDays: 7,
  });
  assert.deepEqual(
    parseSettings({ attention: { reviewDays: 9, noMeetingDays: 'x', unansweredDays: 500 } })
      .attention,
    {
      reviewDays: 9,
      unansweredDays: 5,
      noCandidatesDays: 3,
      noMeetingDays: 7,
    },
  );
});

await test('every limit is a whole number of days from 1 to 60', () => {
  assert.equal(settingsInputSchema.safeParse(input).success, true);
  for (const bad of [0, 61, 1.5, -2]) {
    const value = { attention: { ...input.attention, reviewDays: bad } };
    assert.equal(settingsInputSchema.safeParse(value).success, false, `${bad} is refused`);
  }
  assert.equal(settingsInputSchema.safeParse({ attention: { reviewDays: 2 } }).success, false);
});

await test('an admin reads and saves the settings, and the change is recorded', async () => {
  const { service, events, stored } = setup();
  assert.equal((await service.get(actor('admin'))).attention.reviewDays, 2);
  const saved = await service.save(actor('admin'), input, 'c');
  assert.deepEqual(saved.attention, input.attention);
  assert.deepEqual(stored().attention, input.attention);
  assert.equal(events[0]?.type, 'settings.updated');
});

await test('only an admin reads or changes the settings', async () => {
  const { service } = setup();
  for (const role of ['agent', 'member', 'guardian'] as const) {
    await assert.rejects(
      service.get(actor(role)),
      (e) => e instanceof AppError && e.status === 403,
    );
    await assert.rejects(
      service.save(actor(role), input, 'c'),
      (e) => e instanceof AppError && e.status === 403,
    );
  }
});
