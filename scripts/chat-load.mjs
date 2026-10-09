#!/usr/bin/env node
/**
 * Chat load test: opens N socket connections, puts them in one group plus DM pairs, sends messages
 * at a steady rate and reports send-ack latency (p50/p95/p99), delivery latency, failures and the
 * server's event-loop lag (sampled from /api/health response time).
 *
 * NEVER run against production data. It creates load-test users in the database it is pointed at.
 *
 *   LOAD_TEST=1 MONGODB_URI=... JWT_SECRET=... node scripts/chat-load.mjs \
 *     --url http://localhost:3000 --users 200 --rate 50 --seconds 60 --group 50
 *
 * --users    connections (one user each)              default 100
 * --rate     messages per second across all senders   default 20
 * --seconds  test duration                            default 30
 * --group    members in the shared group (<= users, <= CHAT_GROUP_MAX_MEMBERS)  default 50
 */
import { performance } from 'node:perf_hooks';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { io } from 'socket.io-client';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const URL_ = arg('url', 'http://localhost:3000');
const USERS = Number(arg('users', 100));
const RATE = Number(arg('rate', 20));
const SECONDS = Number(arg('seconds', 30));
const GROUP = Math.min(Number(arg('group', 50)), USERS);

if (process.env.LOAD_TEST !== '1' || process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: set LOAD_TEST=1 and point MONGODB_URI at a non-production database.');
  process.exit(1);
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const summary = (label, values) => {
  const s = [...values].sort((a, b) => a - b);
  console.log(`${label.padEnd(18)} n=${s.length}  p50=${pct(s, 50).toFixed(1)}ms  p95=${pct(s, 95).toFixed(1)}ms  p99=${pct(s, 99).toFixed(1)}ms`);
};

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const now = new Date();

// Load-test college + verified users (idempotent by email).
const college = (
  await db.collection('colleges').findOneAndUpdate(
    { code: 'LOADTEST' },
    { $setOnInsert: { name: 'Load Test College', code: 'LOADTEST', domains: ['loadtest.invalid'], verificationStatus: 'approved', active: true, admin: new mongoose.Types.ObjectId(), createdAt: now, updatedAt: now } },
    { upsert: true, returnDocument: 'after' }
  )
);
const collegeId = (college.value ?? college)._id;
const users = [];
for (let i = 0; i < USERS; i++) {
  const email = `load${i}@loadtest.invalid`;
  const u = await db.collection('users').findOneAndUpdate(
    { email },
    { $setOnInsert: { name: `Load ${i}`, email, password: 'x', role: 'student', college: collegeId, collegeVerification: { verified: true, collegeId }, followers: [], following: [], followedColleges: [], createdAt: now, updatedAt: now } },
    { upsert: true, returnDocument: 'after', projection: { _id: 1, tokenVersion: 1 } }
  );
  const doc = u.value ?? u;
  users.push({ id: String(doc._id), token: jwt.sign({ userId: String(doc._id), email, role: 'student', tv: doc.tokenVersion ?? 0 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '2h' }) });
}

// Connect everyone.
const t0 = performance.now();
const sockets = await Promise.all(
  users.map(
    (u) =>
      new Promise((resolve, reject) => {
        const s = io(URL_, { transports: ['websocket'], auth: { token: u.token }, reconnection: false, forceNew: true });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      })
  )
);
console.log(`connected ${sockets.length} sockets in ${(performance.now() - t0).toFixed(0)}ms`);

// One group (first GROUP users) via REST, DM pairs for the rest.
const rest = async (token, method, path, body) => {
  const r = await fetch(`${URL_}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return r.json();
};
const owner = users[0];
const { group } = await rest(owner.token, 'POST', '/chat/groups', { name: `Load ${Date.now()}`, visibility: 'closed', inviteUserIds: users.slice(1, GROUP).map((u) => u.id) });
await Promise.all(
  users.slice(1, GROUP).map(async (u) => {
    const { invites } = await rest(u.token, 'GET', '/chat/invites');
    const mine = invites.find((i) => i.group._id === group._id);
    if (mine) await rest(u.token, 'POST', `/chat/invites/${mine._id}/accept`);
  })
);
const conversations = [{ id: group._id, senders: users.slice(0, GROUP).map((_, i) => i) }];
for (let i = GROUP; i + 1 < USERS; i += 2) {
  const { conversation } = await rest(users[i].token, 'POST', '/chat/direct', { userId: users[i + 1].id });
  conversations.push({ id: conversation._id, senders: [i, i + 1] });
}

// Delivery latency: time from send to each recipient's message:new.
const sentAt = new Map();
const delivery = [];
sockets.forEach((s) => s.on('message:new', ({ message }) => {
  const at = sentAt.get(message.clientMessageId);
  if (at) delivery.push(performance.now() - at);
}));

// Steady send loop; each sender stays under the 30 msgs / 10 s per-user limit.
const ackLatency = [];
let failures = 0;
let sent = 0;
const lag = [];
const lagTimer = setInterval(async () => {
  const s = performance.now();
  await fetch(`${URL_}/api/health`).catch(() => undefined);
  lag.push(performance.now() - s);
}, 1000);
const end = Date.now() + SECONDS * 1000;
let k = 0;
while (Date.now() < end) {
  const c = conversations[k % conversations.length];
  const senderIndex = c.senders[Math.floor(k / conversations.length) % c.senders.length];
  const clientMessageId = `load-${process.pid}-${k}`;
  const start = performance.now();
  sentAt.set(clientMessageId, start);
  sent++;
  sockets[senderIndex].timeout(10000).emit('message:send', { conversationId: c.id, clientMessageId, text: `load ${k}` }, (err, reply) => {
    if (err || !reply?.ok) failures++;
    else ackLatency.push(performance.now() - start);
  });
  k++;
  await new Promise((r) => setTimeout(r, 1000 / RATE));
}
await new Promise((r) => setTimeout(r, 3000)); // let acks and deliveries land
clearInterval(lagTimer);

console.log(`\nsent=${sent} acked=${ackLatency.length} failed=${failures} (${((failures / Math.max(sent, 1)) * 100).toFixed(2)}%)  deliveries=${delivery.length}`);
summary('send ack', ackLatency);
summary('delivery', delivery);
summary('health (lag proxy)', lag);
const mem = await fetch(`${URL_}/api/health`).then((r) => r.json()).catch(() => ({}));
console.log(`server sockets=${mem.sockets ?? '?'} redis=${mem.redis ?? '?'}`);

sockets.forEach((s) => s.close());
await mongoose.disconnect();
process.exit(0);
