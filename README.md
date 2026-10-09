# College Connect - Backend

Express + TypeScript + MongoDB (Mongoose) + Redis.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill it in (every variable is documented there).
   The server refuses to start without `JWT_SECRET` (32+ chars) and, in production,
   without `MONGODB_URI`, `REDIS_URL` and `CLIENT_URL`.
3. Start Redis: `redis-server` (the API still boots without it - see "Redis" below).
4. `npm run dev` (watch mode) - or `npm run build && npm start` for production.
5. `npm run typecheck` before committing.

## Project structure

```
src/
  app.ts               express app: global middleware + one line per feature module
  server.ts            connects Mongo/Redis, starts HTTP, graceful shutdown
  config/              env (validated at startup), Redis client + helpers
  middleware/          auth (authenticate, requireRole, requireVerified), error, rateLimit
  utils/               ApiError + asyncHandler, request input helpers, jwt, email validation
  types/               shared enums/interfaces, req.user typing
  services/email/      email provider adapters (mailgun | log)
  modules/<feature>/   everything for one feature
    <feature>.routes.ts      URL -> middleware -> controller
    <feature>.controller.ts  HTTP in/out only
    <feature>.service.ts     business logic reused across handlers (when needed)
    <feature>.model.ts       Mongoose schema, indexes, field constants
```

Modules: `auth`, `users`, `colleges`, `verification`, `posts`, `feed`, `portal` (college reps), `applications` (admin review of reps).

### Adding a feature

1. Create `src/modules/<feature>/` with routes + controller (+ model/service if needed).
2. Mount the router in `app.ts`.
3. Follow the conventions below - no other wiring is required.

### Conventions

- **Errors:** `throw new ApiError(status, CODE, message)` anywhere. Wrap async handlers in
  `asyncHandler`; never write try/catch just to send a 500. The error middleware maps
  Mongoose errors (bad id -> 404, validation -> 400, duplicate key -> 409) and body-parser
  errors for you. Every error response is `{ success: false, error: { code, message } }`.
- **Input:** read every user string with `str()` (blocks `{ "$gt": "" }` NoSQL injection),
  escape anything going into `$regex` with `escapeRegex()`, paginate with `parsePagination()`.
  Put limits (`maxlength`, `enum`, `min/max`) in the schema - they run on create and on
  updates with `runValidators: true`.
- **Auth:** `authenticate` loads the user once and sets `req.user`
  (`userId, email, role, collegeId, verified`) from the DB. Use `requireRole(...)` and
  `requireVerified` instead of re-querying the user in controllers.
- **Never leak private fields:** `password` is `select: false`. When returning other users
  use `PUBLIC_USER_FIELDS` / `AUTHOR_FIELDS` (users) and `COLLEGE_SUMMARY_FIELDS` - never
  emails or verification data.
- **Concurrency:** toggles and counters use atomic `$addToSet` / `$pull` / `$inc`,
  not read-modify-save.
- **Reads:** use `.lean()` for read-only queries and `Promise.all` for independent ones.
- **`ponytail:` comments** mark deliberate simplifications with a known ceiling and the upgrade path.

## Access rules

| Who | Can |
| --- | --- |
| Signed out | sign up / log in / forgot password |
| New account (student or authority), email not yet confirmed | only `/auth/me` + verify-account (everything else `403 ACCOUNT_NOT_VERIFIED`) |
| Any signed-in user | global feed (people/colleges they follow + own posts), like, comment (30 / 10 min), follow people and colleges, see who liked/upvoted |
| College-verified | + create posts, read their college feed |
| Faculty/staff pending or rejected by their college rep | verified-member powers, no upvote (rejected can reapply) |
| Faculty / staff (approved by their college) / admin | + upvote |
| College rep (portal) | verify email, apply, then (approved) edit profile + approve faculty |
| Admin (env login) | admin panel: colleges + domains |

College-type posts are visible only to members of that college (others get 404).
Colleges are public (search, profile, posts, follow) only when approved **and** active.

## Redis

Used for OTP storage and rate limiting. If Redis is down the API still runs:
OTP endpoints and admin login fail closed (`503`), signup/login rate limits fail open.

| Key | Purpose | TTL |
| --- | --- | --- |
| `rate:login:{ip}:{email}` | 10 login attempts | 15 min |
| `rate:admin-login:{ip}` | 5 admin login attempts | 15 min |
| `rate:signup:{ip}` | 20 signups | 1 h |
| `rate:reset:{ip}:{email}` | 10 forgot/reset requests | 15 min |
| `otp:{purpose}:*` | OTP engine, see "Email OTP" | |
| `rate:media-user:{userId}` / `rate:media-ip:{ip}` | 10 / 30 upload URLs | 1 min |
| `rate:media-daily-count:{userId}` / `rate:media-daily-bytes:{userId}` | 50 URLs / 500 MB declared | 24 h |
| `lock:media-sweeper` | one sweeper run at a time | 10 min |

Behind a reverse proxy set `TRUST_PROXY=1` so limits use the real client IP.

## API Endpoints

### Auth
- `POST /api/auth/signup` - Create account. `role`: `student` or `faculty` ("College Authority"; anything else -> student). Password 8-72 chars.
  Authorities also send `collegeId` + `designation` (max 60) and must use an email on that college's domains;
  confirming the emailed code also verifies their college (the college is set only then). Upvoting waits for the
  college rep's approval; profiles and search show the designation only once approved.
- `POST /api/auth/login` - Sign in
- `POST /api/auth/admin-login` - Admin panel sign-in (`ADMIN_EMAIL` / `ADMIN_PASSWORD`)
- `GET /api/auth/me` - Current user (same shape as signup/login `user`)
- `PATCH /api/auth/profile` - Update `name`, `bio`, `department`, `graduationYear`, `avatarAssetId`, `bannerAssetId`
- `POST /api/auth/verify-account/request` - Resend the signup code (new accounts)
- `POST /api/auth/verify-account/confirm` - `{ otp }` - confirm the signup email
- `POST /api/auth/faculty-reapply` - A rejected authority asks their college again (3 / 24 h)
- `POST /api/auth/forgot-password` - `{ email }` - always 200 (never reveals whether the account exists)
- `POST /api/auth/reset-password` - `{ email, otp, password }` - logs out every session

### College verification
- `POST /api/college-verification/request-otp` - `{ collegeId, email, stream?, batchStart?, batchEnd? }` - email a code to the college address
- `POST /api/college-verification/verify-otp` - Verify the code and mark the user verified

### Users
- `GET /api/users/search?query=` - Search students/faculty/staff by name
- `GET /api/users/:userId` - Public profile + `isFollowing`, `followerCount`, `followingCount`
- `GET /api/users/:userId/posts` - Their global posts, newest first
- `POST /api/users/:userId/follow` - Follow/unfollow
- `GET /api/users/:userId/followers` / `following`

### Colleges
- `GET /api/colleges` - List approved colleges with their email domains. **Public** (signup picker)
- `GET /api/colleges/search?q=` - Search approved, active colleges by name (max 20)
- `GET /api/colleges/:collegeId` - `{ college, stats, isFollowing }`
- `GET /api/colleges/:collegeId/posts?page=&limit=` - Members' global posts, newest first
- `POST /api/colleges/:collegeId/follow` - Follow/unfollow (any signed-in user) -> `{ isFollowing, followerCount }`

### College portal (reps, `/api/college-portal`)
- `POST /register`, `POST /login` - Rep accounts (official college email; free providers refused)
- `POST /request-otp`, `POST /verify-otp` - Prove the email domain
- `POST /application` - Apply: claim of the college owning the domain, or a new (pending) college
- `GET /me` - Status, managed college, stats (when approved)
- `PATCH /college` - Edit profile fields (description, images, location); name/code/domains are admin-only
- `GET /faculty-requests`, `POST /faculty-requests/:userId/approve|reject` - Pending faculty/staff who confirmed their email, oldest request first. Reject keeps the account (they can reapply)

### Admin - college applications (`/api/admin/college-applications`)
- `GET /` - Pending applications (`type: new | claim`)
- `POST /:repId/approve` - New: college goes live. Claim: rep linked to the college
- `POST /:repId/reject` - `{ reason }` required. New: pending college deleted

### Colleges - admin only
- `POST /api/colleges` - Create college
- `GET /api/colleges/admin/list` - List all colleges (`?active=true|false`, `?query=`)
- `PATCH /api/colleges/:collegeId` - Update college fields
- `POST /api/colleges/:collegeId/enable` / `disable`
- `PUT /api/colleges/:collegeId/domains` - Replace domain list
- `POST /api/colleges/:collegeId/domains` - Add domains
- `DELETE /api/colleges/:collegeId/domains/:domain` - Remove a domain

### Posts
- `POST /api/posts` - Create post (verified; max 10 tags, 4 images)
- `GET /api/posts/:postId` - Get post
- `PATCH /api/posts/:postId` - Edit own post: `{ content?, tags?, keepMedia?: [publicUrl], media?: [assetId] }`
  (audience fixed; removed media is deleted from storage after the save)
- `DELETE /api/posts/:postId` - Delete own post: post + comments + tag counts in one MongoDB transaction
  (**needs a replica set** - Atlas is one; a plain local `mongod` is not), then its media from storage
- `POST /api/posts/:postId/like` - Toggle like
- `POST /api/posts/:postId/upvote` - Toggle upvote (verified faculty/staff/admin)
- `POST /api/posts/:postId/comments` - Add comment, or a reply with `parentId` (one level: a reply to a reply joins the same thread; rate-limited)
- `GET /api/posts/:postId/upvoters` - Who upvoted
- `GET /api/posts/:postId/likers` - Who liked (same visibility as the post)
- `GET /api/posts/:postId/comments?page=` - 25 top-level comments per page (newest first), each with its first 10 replies
  (oldest first) and `replyCount`, in one aggregation; `hasMore` tells the client to load the next page
- `GET /api/posts/:postId/comments/:commentId/replies?page=` - "View more replies": 10 per page, oldest first (`hasMore`)
- `PATCH /api/posts/:postId/comments/:commentId` - Edit own comment
- `DELETE /api/posts/:postId/comments/:commentId` - Comment author or post author; a top-level comment takes its replies
- `POST /api/posts/:postId/comments/:commentId/like` - Toggle like

### Media (uploads straight to storage)
- `POST /api/media/upload-url` - `{ resourceType, contentType, fileSize, extension, collegeId? }` -> `{ uploadUrl, assetId, key, expiresIn }`
- `DELETE /api/media/:assetId` - discard your own pending upload
- Attach with `avatarAssetId` / `bannerAssetId` (`PATCH /api/auth/profile`), `media: [assetId]` (`POST /api/posts`),
  `logoAssetId` / `bannerAssetId` (college admin/portal updates). `''` removes an image.

### Feed (all support `?page=&limit=`, limit max 50)
- `GET /api/feed/global` - Following feed: followed people/colleges, own college, own posts (`?tag=` searches all)
- `GET /api/feed/college` - College feed (verified)
- `GET /api/feed/explore` - All global posts, most upvoted first
- `GET /api/feed/tags/trending` - Trending tags

## Admin panel

There is **no admin signup**. Configure `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the env,
then sign in at `/admin/login`. The credentials are compared in constant time directly
against the env values.

- The first successful login lazily creates a `User` with that email and `role: admin`
  (or promotes the existing user with that email), so the normal
  `authenticate` / `requireRole('admin')` middleware keep working unchanged.
- `POST /api/auth/signup` silently ignores `admin` - anyone can only register as
  student or faculty (college authority).
- Wrong credentials -> `401 INVALID_CREDENTIALS`; env not set -> `503 AUTH_NOT_CONFIGURED`.
- The panel itself lives at `/admin/colleges` and covers listing, searching, creating,
  editing colleges, managing their domains and enabling/disabling them.

## Email OTP

One engine (`modules/verification/otp.service.ts`) proves email ownership for every flow:
`issueOtp(purpose, userId, email, options)` / `consumeOtp(purpose, userId, email, otp)`.
Purposes: `account` (student signup email), `reset` (forgot password), `college` (college email),
`portal` (college rep email). Each purpose has its own keys, so a code for one can never be used for another.

### College verification flow
1. The user picks a college (`GET /api/colleges` - approved + active, with domains).
2. `POST /api/college-verification/request-otp` with `{ collegeId, email, stream, batchStart, batchEnd }`
   (stream/batch required for students). The email's domain must be one of **that** college's domains,
   otherwise `400 EMAIL_DOMAIN_MISMATCH` "This email domain does not belong to {college}".
3. `POST /api/college-verification/verify-otp` with `{ email, otp }`.
4. On success the user gets `collegeVerification { verified, collegeId, collegeEmail, method, verifiedAt }`,
   plus `stream`, `batchStart`, `batchEnd` for students.

### Redis keys and TTLs
| Key | Purpose | TTL |
| --- | --- | --- |
| `otp:{purpose}:code:{userId}` | Hashed OTP + email + attempts + context | 300 s |
| `otp:{purpose}:resend:{userId}` | Resend cooldown marker | 60 s |
| `otp:{purpose}:hourly:{userId}` | Requests in the current hour | 3600 s |

### Limits (enforced server-side)
- 1 OTP request per 60 seconds
- 5 OTP requests per hour per user
- 5 wrong attempts per OTP, then the OTP is deleted
- OTP expires after 5 minutes; a new request replaces the previous OTP
- Successful verification deletes the OTP and resets the counters

### Error codes
`INVALID_EMAIL`, `EMAIL_DOMAIN_MISMATCH`, `ACCOUNT_NOT_VERIFIED`, `ALREADY_VERIFIED`,
`OTP_REQUEST_TOO_FREQUENT`, `OTP_HOURLY_LIMIT_EXCEEDED`, `OTP_EXPIRED`,
`INVALID_OTP`, `EMAIL_MISMATCH`, `MAX_ATTEMPTS_EXCEEDED`, `EMAIL_SEND_FAILED`,
`SERVICE_UNAVAILABLE`

Errors look like `{ "success": false, "error": { "code": "...", "message": "..." } }`.

## Email providers

Providers are adapters selected by `EMAIL_PROVIDER` (see `.env.example`):

| Value | Behaviour |
| --- | --- |
| `mailgun` | Sends through the Mailgun HTTP API (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`) |
| `log` | Dev only - logs recipient/subject metadata, never the body or OTP |

To add another provider (SendGrid, Postmark, SES, ...), add an adapter under
`src/services/email/providers/` and register it in `src/services/email/emailProvider.ts`.
Nothing in the verification flow needs to change.

## Manual verification checklist

Run this once Redis and an email provider are configured (the automated checks for
college/domain validation, indexes and OTP hashing already pass locally).

**Setup**
1. Start `redis-server`, then `npm run dev` - the log shows `Connected to Redis`.
2. Stop Redis and restart - the log warns `Redis not reachable`, the API still boots, and
   `POST /api/college-verification/request-otp` (with a token) returns `503 SERVICE_UNAVAILABLE`.
3. As an admin, create a college with a domain: `POST /api/colleges`
   `{ "name": "...", "domains": ["example.edu.in"] }` - the same call as a non-admin returns `403`.
4. Create a second college with the same domain -> `409 DOMAIN_ALREADY_ASSIGNED`.

**OTP happy path**
5. As a normal user: `POST /api/college-verification/request-otp`
   `{ "email": "you@example.edu.in" }` -> `{ "success": true, "message": "Verification code sent to your college email." }`
   and confirm the response body never contains a code.
6. The email arrives with a 6-digit code that expires in 5 minutes.
7. `POST /api/college-verification/verify-otp` with the code ->
   `{ "success": true, "message": "College email verified successfully.", "college": { "id": "...", "name": "..." } }`.
8. `GET /api/auth/me` -> `collegeVerification` has `verified`, `collegeId`, `collegeEmail`,
   `method: "email"` and `verifiedAt`, and the legacy `college` / `collegeEmail` /
   `collegeEmailVerified` fields are set as well.
9. Repeating step 5 now returns `409 ALREADY_VERIFIED`.

**Rate limits (Redis keys above)**
10. Request again immediately -> `429 OTP_REQUEST_TOO_FREQUENT` (60 s cooldown).
11. Wait 60 s and repeat 5 times within an hour -> the 6th returns `429 OTP_HOURLY_LIMIT_EXCEEDED`.
12. Enter a wrong code 5 times -> `429 MAX_ATTEMPTS_EXCEEDED` and the key is gone
    (`redis-cli GET otp:college:code:{userId}` returns nothing).
13. `redis-cli TTL otp:college:code:{userId}` never exceeds 300 s, and a wrong
    attempt does not extend it (`KEEPTTL`).
14. Requesting a new code invalidates the previous one.
15. Wait 5 minutes without verifying -> `400 OTP_EXPIRED`.
16. After a successful verify the `otp`, `resend` and `hourly` keys are all deleted.

**Security**
17. Choose college A and enter an email on college B's domain -> `400 EMAIL_DOMAIN_MISMATCH`
    naming college A; the college is always re-checked against the email.
18. A different email than the one the code was issued for -> `400 EMAIL_MISMATCH`.
19. An unknown or pending `collegeId` -> `404 NOT_FOUND`.
20. Disable the college (`POST /api/colleges/:id/disable`) and request again -> `404 NOT_FOUND`.
21. `POST /api/auth/verify-college` -> `404` (the old client-supplied bypass is gone).
22. Grep the server logs after a full flow - no OTP value is ever logged.

Admin panel:

23. `POST /api/auth/signup` with `"role": "admin"` -> the account is created as `student`.
24. `POST /api/auth/admin-login` with a wrong password -> `401 INVALID_CREDENTIALS`; with
    `ADMIN_EMAIL` / `ADMIN_PASSWORD` removed from the env -> `503 AUTH_NOT_CONFIGURED`.
25. Sign in at `/admin/login` with the env credentials -> you land on `/admin/colleges`, and the
    first login creates the `User` with `role: admin` (sign out from the sidebar).
26. Visit `/admin/colleges` while signed out, or as a normal user on any `/api/colleges/admin/*`
    route -> redirected to `/admin/login` / `403 FORBIDDEN`.
27. Add a college (name + one domain, code optional) -> the card appears with a generated code,
    the domain is stored lowercase without `@`, and students can now find the college via
    `GET /api/colleges` (admin-created colleges are auto-`APPROVED`).
28. Edit the college to add/remove domains and save -> `GET /api/colleges/admin/list` reflects the
    new list; a domain already used by another college -> `409 DOMAIN_ALREADY_ASSIGNED`.
29. Disable the college from its card -> the badge flips to `Disabled` and an OTP request for that
    domain returns `404 NOT_FOUND` (step 20); Enable restores it.

## Public media storage (Cloudflare R2)

**Flow:** the browser asks `POST /api/media/upload-url` → the API validates, rate-limits, generates the
object key and signs a 10-minute PUT URL (Content-Type and Content-Length are part of the signature) →
the browser PUTs the file **directly to R2** → the profile/post/college save sends the `assetId`; the
API HEAD-checks the object once and stores the **object key**. Every JSON response turns stored keys into
`R2_PUBLIC_BASE_URL/<key>` (`modules/media/media.serializer.ts`), so feeds never call storage and changing
domain/provider needs no data migration. Old `https://` image links keep working unchanged.

**Code layout:** `services/storage/` is the provider-independent `StorageService` (`R2StorageService` is
the only code that knows the AWS SDK/R2). `modules/media/` holds the rules table (`media.constants.ts`:
types, size limits, quotas), asset records, upload/attach logic and the sweeper. Adding a provider =
one new class in `services/storage/providers/` + a case in `services/storage/index.ts`. A private bucket
(chat files) later = a second `StorageService` instance plus signed GET URLs - nothing here changes.

**Keys:** `users/{userId}/avatar|banner/{uuid}.{ext}`, `posts/{userId}/{uuid}.{ext}`,
`colleges/{collegeId}/logo|banner/{uuid}.{ext}` - server-generated, unique, never overwritten
(cache-friendly: a new image is a new key).

**Cleanup:** uploads not attached within 24 h, and objects whose delete failed, are removed by the
in-app sweeper every 15 minutes (Redis lock: one instance at a time).

### R2 setup (one time)
1. Create an R2 API token with **Object Read & Write** on this bucket only; put its keys in `.env`.
2. Connect a **custom domain** to the bucket (e.g. `media.example.com`) and set `R2_PUBLIC_BASE_URL`.
   Do not use the `r2.dev` URL in production. Optional: a Cloudflare cache rule with a long TTL - keys are immutable.
3. Bucket → Settings → **CORS policy** (only your real origins, PUT only):
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:5173", "https://your-app-domain.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. Manual test: sign in, open Profile → upload a picture → Save. The network tab shows a `PUT` to
   `<account>.r2.cloudflarestorage.com` (not to the API), and the avatar loads from `R2_PUBLIC_BASE_URL`.

## Chat (DMs and groups)

Module: `src/modules/chat`.
- `chat.service.ts` and `chat.groups.ts` hold every rule. REST (`chat.controller.ts`) and sockets
  (`chat.realtime.ts`) both call them.
- `chat.policy.ts` decides who may talk to whom.
- Messages are not end-to-end encrypted: they are protected by TLS in transit and normal database
  security at rest.

**Rules**
- **DMs:** you can message someone if either of you follows the other, or you are both verified
  members of the same college. Existing DMs keep working after an unfollow.
- **Groups are college-only:**
  - every member is verified at the group's college;
  - roles are admin and member;
  - `open` groups are searchable within the college and joined by request;
  - `closed` groups are joined by invite or invite link (a link creates a request);
  - with `allowFaculty` (open only), approved faculty/staff join directly.
- **Admins:**
  - can invite, approve/reject requests, remove members (never other admins), promote, rename,
    and create 24-hour invite links;
  - when the last admin leaves or steps down, the longest-serving member becomes admin;
  - when the last member leaves, the group is archived.
- **History:** new members see the full history.
- **Messages:**
  - text up to 4000 characters;
  - edit your own within 15 minutes;
  - delete your own, or any message as a group admin (the text is cleared, shown as "Message deleted").

**Data:**
- `conversations` (unique `directKey` for DM pairs);
- `conversation_members` (role, read cursor, stored `unreadCount`);
- `messages` (`{conversationId, _id}` index; unique `clientMessageId` per sender for idempotent retries);
- `group_requests`;
- `group_invite_links` (hashed token, TTL index).

Indexes are created by Mongoose on startup.

### REST (`/api/chat`, signed in)

| Method & path | Purpose |
|---|---|
| `GET /conversations?type=direct\|group&before=<lastMessageAt>` | My chats (30/page), with `unreadCount`, `lastMessage`, DM `other` |
| `GET /unread` | `{ total }` for the badge |
| `POST /direct` `{ userId }` | Start or get a DM |
| `GET /eligible?q=` | People I can DM |
| `GET /conversations/:id` | Details, my role, members |
| `GET /conversations/:id/messages?before=<messageId>` | History, newest first, 30/page, `hasMore` |
| `POST /conversations/:id/messages` `{ text, clientMessageId }` | Send (also available over the socket) |
| `POST /conversations/:id/read` `{ messageId }` | Mark read |
| `PATCH /messages/:messageId` `{ text }` / `DELETE /messages/:messageId` | Edit / delete |
| `POST /groups` `{ name, visibility, allowFaculty?, inviteUserIds? }` | Create (10/day) |
| `GET /groups/search?q=` | Open groups of my college |
| `PATCH /groups/:id` `{ name?, allowFaculty? }` | Admin settings |
| `POST /groups/:id/join` | Join (faculty + allowFaculty) or request |
| `POST /groups/:id/invites` `{ userIds }` | Admin invites |
| `GET /groups/:id/requests`, `POST /groups/:id/requests/:requestId/approve\|reject` | Admin |
| `GET /invites`, `POST /invites/:requestId/accept\|decline` | My invites |
| `POST /groups/:id/links` → `{ token, expiresAt }` | Admin: 24 h link (30/hour); the app shares `/join/<token>` |
| `POST /links/:token` | Use a link (410 when expired) |
| `DELETE /groups/:id/members/:userId`, `POST .../promote`, `POST /groups/:id/step-down`, `POST /groups/:id/leave` | Membership |

### Socket.IO (same host and port as the API, path `/socket.io`, websocket transport only)

- **Connect:** `io(API_ORIGIN, { transports: ['websocket'], auth: { token } })`.
  - The token is checked like REST: an old token after a password reset is refused.
  - Every mutating event re-checks the token; a revoked session is disconnected.

**Client to server** (each with an ack `{ ok, error?: { code, message }, ... }`):

| Event | Payload | Ack |
|---|---|---|
| `message:send` | `{ conversationId, clientMessageId, text }` | `{ ok, message }` once the message is saved in MongoDB |
| `message:edit` | `{ messageId, text }` | `{ ok, message }` |
| `message:delete` | `{ messageId }` | `{ ok, message }` |
| `conversation:read` | `{ conversationId, messageId }` | `{ ok, unreadCount }` |
| `presence:get` | `{ userIds }` (max 50) | `{ ok, online }` |
| `typing` | `{ conversationId, typing }` | none (best effort, 20/10 s) |

**Server to client:**

| Event | Payload |
|---|---|
| `message:new` | `{ conversationId, message }` |
| `message:updated` | `{ conversationId, message }` |
| `conversation:read` | `{ conversationId, userId, messageId }` (DM "seen"; my other devices) |
| `conversation:updated` | `{ conversationId }` (refetch: membership, rename, archive) |
| `typing` | `{ conversationId, userId, name, typing }` (clients hide it after 6 s) |
| `sync` | `{}` on every connect: refetch the chat list and the open chat |

**Delivery semantics:**
- ✓ (the ack) means saved.
- ✓✓ means the other member's read cursor passed the message (DMs only).
- There is no "delivered" state.
- Events are hints, MongoDB is the source of truth: a client that missed events (offline, an
  instance restart between saving and publishing) catches up on `sync`.
- No outbox: the worst case is a delayed event, never a lost message.

**Limits:**
- `message:send`/`edit`: 30 per 10 s per user (shared with REST). It **fails open** if Redis is
  down, so chat keeps working.
- Groups: 10 per day. Links: 30 per hour. Membership actions: 60 per 10 min.
- Group size: `CHAT_GROUP_MAX_MEMBERS` (100).

### Scaling and deployment

- **One instance (Render today):** nothing extra; Render supports WebSockets on the same service.
- **Several instances:** point them all at the same `REDIS_URL`.
  - The `@socket.io/redis-adapter` (pub/sub on two extra Redis connections per instance) carries
    events between instances.
  - Because the transport is websocket-only, **no sticky sessions** are needed.
  - The load balancer must allow WebSocket upgrades and an idle timeout of at least 60 s.
- **Redis down:**
  - sends still save and reach sockets on the same instance;
  - other instances' clients catch up on reconnect/`sync`;
  - presence and typing pause.
- **Graceful shutdown (SIGTERM):** sockets are closed (clients reconnect elsewhere), then HTTP
  finishes in-flight requests, then Mongo/Redis.
- **Health:** `GET /api/health` → `{ status, sockets, redis }`.
- **Logs:** one JSON line per chat event (`scope: chat`): connect/disconnect counts, slow sends
  (>500 ms), handler errors. Never message text or tokens.

### Load testing

`scripts/chat-load.mjs` opens N sockets, creates one group plus DM pairs in a load-test college,
sends at a steady rate, and prints send-ack and delivery latency (p50/p95/p99), failures, and a
health-check latency (event-loop lag proxy). **Never point it at production data.**

```bash
LOAD_TEST=1 MONGODB_URI=<staging> JWT_SECRET=<same as the API> \
  node scripts/chat-load.mjs --url https://staging-api.example.com --users 500 --rate 100 --seconds 120 --group 100
```

- **Suggested acceptance criteria for one instance:**
  - send-ack p95 < 150 ms and p99 < 400 ms;
  - delivery p95 < 250 ms;
  - failures < 0.1%;
  - health p95 < 50 ms;
  - stable memory over a 10-minute run.
- **Scaling the test:** step up users (500 → 2,000 → 5,000) and rate until a criterion breaks, then
  add instances and repeat to confirm roughly linear scaling.
- **Watch during the run:** process RSS/heap, CPU, event-loop delay, MongoDB write latency (Atlas
  metrics), Redis ops/latency, and network out.
- **Baseline actually measured on a laptop** (single instance, in-memory MongoDB, local Redis):
  100 sockets, 20 msg/s for 20 s, a 50-member group + 25 DMs → 0 failures, ack p95 25 ms,
  delivery p95 28 ms.

That baseline is not a production capacity figure.
