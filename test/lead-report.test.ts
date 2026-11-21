import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bySourceOf,
  leadFunnelQuerySchema,
  revenueShareQuerySchema,
  splitShare,
} from '../src/bo/lead-report.js';
import type { LeadReportUnit } from '../src/db/service/lead-report-db-service.js';
import { AppError } from '../src/exception/app-error.js';
import { LeadReportService } from '../src/service/lead-report-service.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const admin = { agencyId: AGENCY, accountId: 'a', role: 'admin' as const };
const agent = { agencyId: AGENCY, accountId: 'b', role: 'agent' as const };

void test('every source is listed in order with zeros, visits and enquiries add up into the total', () => {
  const { bySource, total } = bySourceOf([
    { source: 'qr', leads: 3, verified: 2, clients: 1, paying: 1, paid: 5000 },
    { source: 'qr', visits: 40 },
    { source: 'facebook', visits: 100, leads: 5 },
  ]);
  assert.deepEqual(
    bySource.map((row) => row.source),
    ['qr', 'google', 'facebook', 'whatsapp', 'old_site', 'other_site', 'direct'],
  );
  assert.deepEqual(bySource[0], {
    source: 'qr',
    visits: 40,
    leads: 3,
    verified: 2,
    contacted: 0,
    clients: 1,
    paying: 1,
    paid: 5000,
  });
  assert.equal(total.visits, 140);
  assert.equal(total.leads, 8);
});

void test('the share is 30 per cent of the total in whole taka, the rest stays with the agency', () => {
  assert.deepEqual(splitShare(10000), { share: 3000, agency: 7000 });
  assert.deepEqual(splitShare(1005), { share: 302, agency: 703 });
  assert.deepEqual(splitShare(0), { share: 0, agency: 0 });
});

void test('the report periods are read strictly', () => {
  assert.throws(() => leadFunnelQuerySchema.parse({ from: '2026-11-21', to: '2026-11-01' }));
  assert.throws(() => leadFunnelQuerySchema.parse({ from: 'yesterday' }));
  assert.throws(() => revenueShareQuerySchema.parse({ month: '2026-13' }));
  assert.equal(revenueShareQuerySchema.parse({ month: '2026-11' }).month, '2026-11');
});

function setup(now = new Date('2026-11-21T20:00:00Z')) {
  const calls: unknown[][] = [];
  const unit = {
    settings: async () => ({ leads: { oldSiteHosts: ['msbd-old.test'] } }),
    addVisit: async (...args: unknown[]) => void calls.push(['visit', ...args]),
    visits: async () => [
      { source: 'qr', campaign: 'wedding-fair', visits: 12 },
      { source: 'facebook', campaign: '', visits: 30 },
    ],
    bySource: async (...args: unknown[]) => {
      calls.push(['bySource', ...args]);
      return [
        { source: 'qr', leads: 2, verified: 2, contacted: 1, clients: 1, paying: 1, paid: 8000 },
      ];
    },
    byCampaign: async () => [
      {
        campaign: 'wedding-fair',
        source: 'qr',
        leads: 2,
        verified: 2,
        contacted: 1,
        clients: 1,
        paying: 1,
        paid: 8000,
      },
    ],
    sharedPayments: async (...args: unknown[]) => {
      calls.push(['payments', ...args]);
      return [
        { id: 'p1', amount: 10000, clientBeforeLead: false },
        { id: 'p2', amount: 5000, clientBeforeLead: true },
      ];
    },
  } as unknown as LeadReportUnit;
  const service = new LeadReportService(
    { inTransaction: async (_a, work) => work(unit) },
    () => now,
  );
  return { calls, service };
}

void test('a visit is counted on its Bangladesh day by source and campaign; a broken origin is a direct visit', async () => {
  const { calls, service } = setup(); // 02:00 on 22 November in Bangladesh
  await service.recordVisit(
    AGENCY,
    { referrer: 'https://msbd-old.test/x', utmCampaign: 'header' },
    null,
  );
  await service.recordVisit(AGENCY, 'garbage', null);
  assert.deepEqual(calls, [
    ['visit', AGENCY, '2026-11-22', 'old_site', 'header'],
    ['visit', AGENCY, '2026-11-22', 'direct', ''],
  ]);
});

void test('the funnel reads the last 30 days by default, adds the visits, and only for an admin', async () => {
  const { calls, service } = setup();
  const funnel = await service.funnel(admin, {});
  assert.deepEqual([funnel.from, funnel.to], ['2026-10-24', '2026-11-22']);
  assert.deepEqual(calls[0], ['bySource', AGENCY, '2026-10-24', '2026-11-22']);
  assert.equal(funnel.bySource[0]!.visits, 12);
  assert.equal(funnel.bySource[0]!.paid, 8000);
  assert.equal(funnel.total.visits, 42);
  assert.equal(funnel.byCampaign[0]!.visits, 12);
  await assert.rejects(service.funnel(agent, {}), (e: AppError) => e.status === 403);
});

void test('the revenue share of a month: total, 30 per cent, and what came from clients there before', async () => {
  const { calls, service } = setup();
  const share = await service.revenueShare(admin, { month: '2026-11' });
  assert.deepEqual(calls[0], ['payments', AGENCY, '2026-11-01']);
  assert.deepEqual(
    [share.total, share.share, share.agency, share.percent],
    [15000, 4500, 10500, 30],
  );
  assert.equal(share.clientBeforeLeadTotal, 5000);
  assert.equal((await service.revenueShare(admin, {})).month, '2026-11');
  await assert.rejects(service.revenueShare(agent, {}), (e: AppError) => e.status === 403);
});
