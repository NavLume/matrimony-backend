import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  feedbackInputSchema,
  followUpInputSchema,
  meetingInputSchema,
  meetingPatchSchema,
  noteInputSchema,
} from '../bo/meeting.js';
import type { MeetingService } from '../service/meeting-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOrGuardian = { roles: ['member' as const, 'guardian' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const clientParams = z.object({ profileId: z.uuid() });
const connectionParams = z.object({ connectionId: z.uuid() });
const meetingParams = z.object({ meetingId: z.uuid() });
const feedbackParams = meetingParams.extend({ profileId: z.uuid() });
const followUpParams = z.object({ followUpId: z.uuid() });

/**
 * Meetings, private notes and follow-ups (see bo/meeting.ts). Staff set and change meetings of the
 * accepted proposals of the clients they look after, record what each side said, keep private notes
 * and follow-ups, and see everything that waits for them on one agenda. A client reads only the
 * time and place of their own meetings.
 */
export function registerMeetingController(
  app: FastifyInstance,
  meetings: Pick<
    MeetingService,
    | 'schedule'
    | 'change'
    | 'recordFeedback'
    | 'forClient'
    | 'mine'
    | 'notes'
    | 'addNote'
    | 'followUps'
    | 'addFollowUp'
    | 'completeFollowUp'
    | 'agenda'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const write = { rateLimit: { max: 60, timeWindow: 60000 } };

  app.get('/api/v1/me/meetings', { config: memberOrGuardian }, async (req) => ({
    items: await meetings.mine(actor(req)),
  }));

  app.get('/api/v1/staff/agenda', { config: staffOnly }, async (req) =>
    meetings.agenda(actor(req)),
  );

  app.post(
    '/api/v1/staff/connections/:connectionId/meetings',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await meetings.schedule(
            actor(req),
            connectionParams.parse(req.params).connectionId,
            meetingInputSchema.parse(req.body),
            req.id,
          ),
        ),
  );
  app.patch(
    '/api/v1/staff/meetings/:meetingId',
    { config: { ...staffOnly, ...write } },
    async (req) =>
      meetings.change(
        actor(req),
        meetingParams.parse(req.params).meetingId,
        meetingPatchSchema.parse(req.body),
        req.id,
      ),
  );
  app.put(
    '/api/v1/staff/meetings/:meetingId/feedback/:profileId',
    { config: { ...staffOnly, ...write } },
    async (req) => {
      const params = feedbackParams.parse(req.params);
      return meetings.recordFeedback(
        actor(req),
        params.meetingId,
        params.profileId,
        feedbackInputSchema.parse(req.body),
        req.id,
      );
    },
  );

  app.get('/api/v1/staff/clients/:profileId/meetings', { config: staffOnly }, async (req) => ({
    items: await meetings.forClient(actor(req), clientParams.parse(req.params).profileId),
  }));

  app.get('/api/v1/staff/clients/:profileId/notes', { config: staffOnly }, async (req) => ({
    items: await meetings.notes(actor(req), clientParams.parse(req.params).profileId),
  }));
  app.post(
    '/api/v1/staff/clients/:profileId/notes',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply.code(201).send({
        items: await meetings.addNote(
          actor(req),
          clientParams.parse(req.params).profileId,
          noteInputSchema.parse(req.body).body,
          req.id,
        ),
      }),
  );

  app.get('/api/v1/staff/clients/:profileId/follow-ups', { config: staffOnly }, async (req) => ({
    items: await meetings.followUps(actor(req), clientParams.parse(req.params).profileId),
  }));
  app.post(
    '/api/v1/staff/clients/:profileId/follow-ups',
    { config: { ...staffOnly, ...write } },
    async (req, reply) =>
      reply.code(201).send({
        items: await meetings.addFollowUp(
          actor(req),
          clientParams.parse(req.params).profileId,
          followUpInputSchema.parse(req.body),
          req.id,
        ),
      }),
  );
  app.post(
    '/api/v1/staff/follow-ups/:followUpId/done',
    { config: { ...staffOnly, ...write } },
    async (req) => ({
      items: await meetings.completeFollowUp(
        actor(req),
        followUpParams.parse(req.params).followUpId,
        req.id,
      ),
    }),
  );
}
