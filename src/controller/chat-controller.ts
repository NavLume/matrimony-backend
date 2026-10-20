import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  messageInputSchema,
  messagePageQuerySchema,
  reportInputSchema,
  resolveInputSchema,
  respondInputSchema,
} from '../bo/chat.js';
import type { ChatService } from '../service/chat-service.js';
import type { ProfileActor } from '../service/profile-service.js';
import './context.js';

const memberOnly = { roles: ['member' as const] };
const staffOnly = { roles: ['admin' as const, 'agent' as const] };
const chatParams = z.object({ chatId: z.uuid() });
const connectionParams = z.object({ connectionId: z.uuid() });
const clientParams = z.object({ profileId: z.uuid() });

/** Chat between two clients, and what staff may see of it (see bo/chat.ts). */
export function registerChatController(
  app: FastifyInstance,
  chats: Pick<
    ChatService,
    | 'list'
    | 'request'
    | 'respond'
    | 'messages'
    | 'send'
    | 'end'
    | 'report'
    | 'staffChats'
    | 'staffMessages'
    | 'staffEnd'
    | 'staffResolve'
  >,
) {
  const actor = (req: {
    principal: { agencyId: string; id: string; role: ProfileActor['role'] } | null;
  }): ProfileActor => ({
    agencyId: req.principal!.agencyId,
    accountId: req.principal!.id,
    role: req.principal!.role,
  });
  const chatId = (req: { params: unknown }) => chatParams.parse(req.params).chatId;

  // ---- a member's conversations ------------------------------------------------------------
  app.get('/api/v1/me/chats', { config: memberOnly }, async (req) => chats.list(actor(req)));

  app.post(
    '/api/v1/me/connections/:connectionId/chat',
    { config: { ...memberOnly, rateLimit: { max: 20, timeWindow: 60000 } } },
    async (req) =>
      chats.request(actor(req), connectionParams.parse(req.params).connectionId, req.id),
  );

  app.get('/api/v1/me/chats/:chatId/messages', { config: memberOnly }, async (req) =>
    chats.messages(actor(req), chatId(req), messagePageQuerySchema.parse(req.query).after),
  );

  // Messages are the one thing a person can send quickly, so they have their own limit.
  app.post(
    '/api/v1/me/chats/:chatId/messages',
    { config: { ...memberOnly, rateLimit: { max: 30, timeWindow: 60000 } } },
    async (req, reply) =>
      reply
        .code(201)
        .send(await chats.send(actor(req), chatId(req), messageInputSchema.parse(req.body).body)),
  );

  app.post('/api/v1/me/chats/:chatId/respond', { config: memberOnly }, async (req) =>
    chats.respond(actor(req), chatId(req), respondInputSchema.parse(req.body).accept, req.id),
  );

  app.post('/api/v1/me/chats/:chatId/end', { config: memberOnly }, async (req) =>
    chats.end(actor(req), chatId(req), false, req.id),
  );

  app.post('/api/v1/me/chats/:chatId/block', { config: memberOnly }, async (req) =>
    chats.end(actor(req), chatId(req), true, req.id),
  );

  app.post(
    '/api/v1/me/chats/:chatId/report',
    { config: { ...memberOnly, rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req, reply) => {
      await chats.report(actor(req), chatId(req), reportInputSchema.parse(req.body).reason, req.id);
      return reply.code(204).send();
    },
  );

  // ---- staff ---------------------------------------------------------------------------------
  app.get('/api/v1/staff/clients/:profileId/chats', { config: staffOnly }, async (req) =>
    chats.staffChats(actor(req), clientParams.parse(req.params).profileId),
  );

  app.get('/api/v1/staff/chats/:chatId/messages', { config: staffOnly }, async (req) =>
    chats.staffMessages(
      actor(req),
      chatId(req),
      messagePageQuerySchema.parse(req.query).after,
      req.id,
    ),
  );

  app.post('/api/v1/staff/chats/:chatId/end', { config: staffOnly }, async (req, reply) => {
    await chats.staffEnd(
      actor(req),
      chatId(req),
      resolveInputSchema.parse(req.body ?? {}).note,
      req.id,
    );
    return reply.code(204).send();
  });

  app.post('/api/v1/staff/chats/:chatId/resolve', { config: staffOnly }, async (req, reply) => {
    await chats.staffResolve(
      actor(req),
      chatId(req),
      resolveInputSchema.parse(req.body ?? {}).note,
    );
    return reply.code(204).send();
  });
}
