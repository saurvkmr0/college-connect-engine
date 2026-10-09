import { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Types } from 'mongoose';
import { Server, Socket } from 'socket.io';
import { config } from '../../config';
import { incrementWindow, redisClient } from '../../config/redis';
import { loadAuthUser } from '../../middleware/auth';
import { AuthUser } from '../../types';
import { ApiError } from '../../utils/apiError';
import { str } from '../../utils/request';
import { User } from '../users/user.model';
import { setChatEmitter } from './chat.events';
import { cachedMemberIds } from './chat.members';
import { ConversationMember } from './chat.model';
import * as chat from './chat.service';

/**
 * Socket.IO for chat. Each socket joins only its own `user:<id>` room; the service sends every
 * event to the member rooms it resolved from MongoDB, so there is nothing to subscribe to without
 * authorization. With Redis, the adapter carries events between instances; without it, events
 * still reach sockets on this instance and everyone else catches up from history (`sync`).
 */

let io: Server | null = null;
const PRESENCE_TTL = 90;
const PRESENCE_REFRESH_MS = 30_000;
const room = (userId: string) => `user:${userId}`;
const presenceKey = (userId: string) => `presence:${userId}`;

/** One structured line per event; never message text or tokens. */
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ scope: 'chat', event, ...fields }));

type Ack = (reply: Record<string, unknown>) => void;

/** Errors safe to show the client. Unknown errors become a generic one (and are logged). */
const toReply = (error: unknown) => {
  if (error instanceof ApiError) return { ok: false, error: { code: error.code, message: error.message } };
  log('handler_error', { error: error instanceof Error ? error.name : 'unknown' });
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } };
};

/** Rate limit for socket events (shares REST's Redis keys). Fails open, like REST sends: chat keeps working through a Redis blip. */
const allow = async (name: string, userId: string, limit: number, windowSeconds: number, failOpen: boolean) => {
  try {
    return (await incrementWindow(`rate:${name}:${userId}`, windowSeconds)) <= limit;
  } catch {
    return failOpen;
  }
};

const rateLimited = () => new ApiError(429, 'RATE_LIMITED', 'You are sending messages too fast. Please slow down.');

/**
 * Wraps a mutating event: re-checks the token (a reset or demotion applies at once), validates,
 * runs the shared service, and always answers through the ack.
 */
const handler =
  (socket: Socket, fn: (user: AuthUser, payload: Record<string, unknown>) => Promise<Record<string, unknown>>) =>
  async (payload: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
    let user: AuthUser;
    try {
      user = await loadAuthUser(socket.data.token);
      socket.data.user = user;
    } catch (error) {
      reply(toReply(error));
      // Only a rejected session ends the connection; a database blip just fails this event.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) socket.disconnect(true);
      return;
    }
    try {
      const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      reply({ ok: true, ...(await fn(user, body)) });
    } catch (error) {
      reply(toReply(error));
    }
  };

/** Registers every listener synchronously, so an event sent right after connecting is never missed. */
const onConnection = (socket: Socket) => {
  const user: AuthUser = socket.data.user;
  socket.join(room(user.userId));
  const name = User.findById(user.userId).select('name').lean().then((me) => me?.name ?? '', () => '');

  // Presence: a connection counter with a TTL (a crashed instance cannot leave anyone "online").
  const touch = () => redisClient.isReady && redisClient.expire(presenceKey(user.userId), PRESENCE_TTL).catch(() => undefined);
  if (redisClient.isReady) {
    redisClient.incr(presenceKey(user.userId)).then(touch, () => undefined);
  }
  const heartbeat = setInterval(touch, PRESENCE_REFRESH_MS);
  heartbeat.unref();
  log('connect', { sockets: io?.engine.clientsCount });

  socket.on(
    'message:send',
    handler(socket, async (u, p) => {
      if (!(await allow('chat-send', u.userId, 30, 10, true))) throw rateLimited();
      const started = Date.now();
      const message = await chat.sendMessage(u, p.conversationId, p);
      const ms = Date.now() - started;
      if (ms > 500) log('slow_send', { ms });
      return { message };
    })
  );
  socket.on(
    'message:edit',
    handler(socket, async (u, p) => {
      if (!(await allow('chat-send', u.userId, 30, 10, true))) throw rateLimited();
      return { message: await chat.editMessage(u, p.messageId, p.text) };
    })
  );
  socket.on('message:forward', handler(socket, async (u, p) => ({ messages: await chat.forwardMessage(u, p.messageId, p.conversationIds) })));
  socket.on('message:delete', handler(socket, async (u, p) => ({ message: await chat.deleteMessage(u, p.messageId) })));
  socket.on('conversation:read', handler(socket, async (u, p) => chat.markRead(u, p.conversationId, p.messageId)));
  socket.on(
    'presence:get',
    handler(socket, async (u, p) => {
      if (!(await allow('chat-presence', u.userId, 60, 60, false))) throw rateLimited();
      const asked = (Array.isArray(p.userIds) ? p.userIds : []).slice(0, 50).map((x) => str(x)).filter((x) => Types.ObjectId.isValid(x));
      if (!asked.length || !redisClient.isReady) return { online: [] };
      // Only people the caller shares a conversation with.
      const mine = await ConversationMember.distinct('conversationId', { userId: new Types.ObjectId(u.userId) });
      const ids = (await ConversationMember.distinct('userId', { conversationId: { $in: mine }, userId: { $in: asked.map((x) => new Types.ObjectId(x)) } })).map(String);
      if (!ids.length) return { online: [] };
      const counts = await redisClient.mGet(ids.map(presenceKey));
      return { online: ids.filter((_, i) => Number(counts[i]) > 0) };
    })
  );

  // Typing: ephemeral, no DB writes, cached membership, silently dropped when over the limit.
  socket.on('typing', async (payload: unknown) => {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const conversationId = chat.oid(body.conversationId);
    if (!conversationId || !(await allow('chat-typing', user.userId, 20, 10, true))) return;
    try {
      const members = await cachedMemberIds(String(conversationId));
      if (!members.includes(user.userId)) return;
      const others = members.filter((id) => id !== user.userId);
      if (others.length) {
        io?.to(others.map(room)).emit('typing', { conversationId, userId: user.userId, name: await name, typing: body.typing === true });
      }
    } catch {
      // Typing is best effort.
    }
  });

  socket.on('disconnect', async () => {
    clearInterval(heartbeat);
    if (redisClient.isReady) {
      const left = await redisClient.decr(presenceKey(user.userId)).catch(() => 1);
      if (left <= 0) await redisClient.del(presenceKey(user.userId)).catch(() => undefined);
    }
    log('disconnect', { sockets: io?.engine.clientsCount });
  });

  // Tell the client to refetch: anything sent while it was away is in MongoDB.
  socket.emit('sync', {});
};

let adapterClients: Array<ReturnType<typeof redisClient.duplicate>> = [];

const attachAdapter = async () => {
  if (!io || adapterClients.length) return;
  try {
    const pub = redisClient.duplicate();
    const sub = redisClient.duplicate();
    pub.on('error', () => undefined);
    sub.on('error', () => undefined);
    await Promise.all([pub.connect(), sub.connect()]);
    adapterClients = [pub, sub];
    io.adapter(createAdapter(pub, sub));
    // Sockets that connected before the swap still point at the old adapter: ask them to
    // reconnect (clients reconnect on "io server disconnect"), which joins the new adapter and
    // resyncs anything missed while Redis was down.
    for (const socket of io.of('/').sockets.values()) socket.disconnect(true);
    log('adapter', { redis: true });
  } catch {
    log('adapter', { redis: false });
  }
};

/** Ends every open socket of a user, on every instance (password reset). */
export const disconnectUser = (userId: string): void => {
  io?.in(room(userId)).disconnectSockets(true);
};

export const attachRealtime = async (httpServer: HttpServer): Promise<Server> => {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: config.clientUrl, credentials: true },
    // Websocket only: no long-polling, so multiple instances need no sticky sessions.
    transports: ['websocket'],
    maxHttpBufferSize: 16 * 1024,
  });

  // Cross-instance events. If Redis is down at boot, attach as soon as it is back.
  if (redisClient.isReady) await attachAdapter();
  else {
    log('adapter', { redis: false });
    redisClient.once('ready', () => void attachAdapter());
  }

  io.use(async (socket, next) => {
    try {
      const token = str(socket.handshake.auth?.token);
      socket.data.user = await loadAuthUser(token);
      socket.data.token = token;
      next();
    } catch (error) {
      next(Object.assign(new Error(error instanceof ApiError ? error.message : 'Unauthorized'), { data: { code: error instanceof ApiError ? error.code : 'UNAUTHORIZED' } }));
    }
  });
  io.on('connection', onConnection);

  setChatEmitter((userIds, event, payload) => io?.to(userIds.map(room)).emit(event, payload));
  return io;
};

/** Local connection count (for /api/health). */
export const socketCount = (): number => io?.engine.clientsCount ?? 0;

/** Graceful shutdown: stop accepting connections and disconnect clients (they reconnect elsewhere). */
export const closeRealtime = async (): Promise<void> => {
  if (!io) return;
  setChatEmitter(() => undefined);
  await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
  await Promise.all(adapterClients.map((c) => c.quit().catch(() => c.disconnect())));
  adapterClients = [];
};
