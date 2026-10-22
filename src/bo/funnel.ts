import { z } from 'zod';

/**
 * The full funnel (22 October 2026): how far the people who registered got, from registering to a match, and how long
 * each step took. Counting people (decided with the owner), one person per profile (and per member account that has
 * not made a profile yet), grouped by when they registered.
 *
 * Nine stages, in order. A person has reached a stage if they reached it or any later one, so the funnel never
 * grows from one stage to the next even where an older record is missing (a match with no fee recorded still passed
 * the fee stage). An admin reads it for the whole agency, or for one agent's clients; an agent reads their own.
 */
const fail = (key: string) => ({ error: key });

export const STAGES = [
  /** A member account was made, or an assisted client was entered by staff. */
  'registered',
  /** The profile was sent for review. */
  'submitted',
  /** The profile was approved and published. */
  'approved',
  /** An agent looks after them and an agreed amount or a payment is recorded. */
  'fee',
  /** The agent released candidates to them. */
  'released',
  /** They sent, or were shown, a connection request. */
  'requested',
  /** A request of theirs was accepted. */
  'accepted',
  /** A meeting was arranged. */
  'meeting',
  /** A match was recorded. */
  'matched',
] as const;
export type Stage = (typeof STAGES)[number];

/** When one person reached each stage, in the order of STAGES; null where there is no record of it. */
export type StageTimes = (Date | null)[];

export interface FunnelStage {
  stage: Stage;
  /** People who reached this stage or a later one. */
  count: number;
  /** As a share of those who registered (0 to 1). */
  ofRegistered: number;
  /** As a share of those who reached the stage before (0 to 1), or null for the first. */
  ofPrevious: number | null;
  /** The average days from the previous stage, over people with a record of both; null when there is none. */
  averageDaysFromPrevious: number | null;
}

export interface Funnel {
  total: number;
  stages: FunnelStage[];
}

const DAY_MS = 24 * 3600 * 1000;

/** Builds the funnel from one row of stage times per person. Pure, so it is tested without a database. */
export function funnelOf(people: readonly StageTimes[]): Funnel {
  const reached = people.map((times) => {
    const flags: boolean[] = [];
    let later = false;
    for (let index = STAGES.length - 1; index >= 0; index--) {
      later = later || times[index] != null;
      flags[index] = index === 0 ? true : later;
    }
    return flags;
  });
  const total = people.length;
  const stages = STAGES.map((stage, index): FunnelStage => {
    const count = reached.filter((flags) => flags[index]).length;
    const previous = index === 0 ? total : reached.filter((flags) => flags[index - 1]).length;
    let sum = 0;
    let n = 0;
    if (index > 0)
      for (const times of people) {
        const from = times[index - 1];
        const to = times[index];
        if (from && to) {
          sum += Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
          n += 1;
        }
      }
    return {
      stage,
      count,
      ofRegistered: total === 0 ? 0 : count / total,
      ofPrevious: index === 0 ? null : previous === 0 ? 0 : count / previous,
      averageDaysFromPrevious: n === 0 ? null : Math.round((sum / n) * 10) / 10,
    };
  });
  return { total, stages };
}

const day = z
  .string(fail('invalid'))
  .regex(/^\d{4}-\d{2}-\d{2}$/, fail('invalid'))
  .optional();

export const funnelQuerySchema = z
  .object({ from: day, to: day, agentId: z.uuid(fail('invalid')).optional() })
  .strict();
export type FunnelQuery = z.output<typeof funnelQuerySchema>;
