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

Modules: `auth`, `users`, `colleges`, `verification`, `posts`, `feed`.

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
| Signed out | sign up / log in |
| Signed in, **not** college-verified | read the global feed (all global posts), view profiles/colleges |
| College-verified | post, like, comment, follow, read their college feed |
| Faculty / staff / admin (verified) | + upvote |
| Admin (env login) | admin panel: colleges + domains |

College-type posts are visible only to members of that college (others get 404).

## Redis

Used for OTP storage and rate limiting. If Redis is down the API still runs:
OTP endpoints and admin login fail closed (`503`), signup/login rate limits fail open.

| Key | Purpose | TTL |
| --- | --- | --- |
| `rate:login:{ip}:{email}` | 10 login attempts | 15 min |
| `rate:admin-login:{ip}` | 5 admin login attempts | 15 min |
| `rate:signup:{ip}` | 20 signups | 1 h |
| `college-verification:*` | see "College email verification" | |

Behind a reverse proxy set `TRUST_PROXY=1` so limits use the real client IP.

## API Endpoints

### Auth
- `POST /api/auth/signup` - Create account (`student`, `faculty`, `staff`; anything else -> student). Password 8-72 chars.
- `POST /api/auth/login` - Sign in
- `POST /api/auth/admin-login` - Admin panel sign-in (`ADMIN_EMAIL` / `ADMIN_PASSWORD`)
- `GET /api/auth/me` - Current user (same shape as signup/login `user`)
- `PATCH /api/auth/profile` - Update `name`, `bio`, `department`, `avatar`, `graduationYear`

### College verification
- `POST /api/college-verification/request-otp` - Email a 6-digit code to the college address
- `POST /api/college-verification/verify-otp` - Verify the code and mark the user verified

### Users
- `GET /api/users/search?query=` - Search users by name
- `GET /api/users/:userId` - Public profile
- `POST /api/users/:userId/follow` - Follow/unfollow (verified)
- `GET /api/users/:userId/followers` / `following`

### Colleges
- `GET /api/colleges` - List approved colleges
- `GET /api/colleges/:collegeId` - College details, member counts, recent global posts

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
- `DELETE /api/posts/:postId` - Delete own post
- `POST /api/posts/:postId/like` - Toggle like (verified)
- `POST /api/posts/:postId/upvote` - Toggle upvote (verified faculty/staff/admin)
- `POST /api/posts/:postId/comments` - Add comment (verified)
- `GET /api/posts/:postId/comments?page=&limit=` - Comments

### Feed (all support `?page=&limit=`, limit max 50)
- `GET /api/feed/global` - Global feed (`?tag=` to filter)
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
  student, faculty or staff.
- Wrong credentials -> `401 INVALID_CREDENTIALS`; env not set -> `503 AUTH_NOT_CONFIGURED`.
- The panel itself lives at `/admin/colleges` and covers listing, searching, creating,
  editing colleges, managing their domains and enabling/disabling them.

## College email verification

The college is resolved **from the email domain only** - a `collegeId` sent by the
client is never trusted. Only `active: true` colleges with a matching domain can be
verified against.

### Flow
1. `POST /api/college-verification/request-otp` with `{ "email": "student@example.edu.in" }`
2. A 6-digit code (crypto.randomInt, HMAC-hashed in Redis) is emailed to that address
3. `POST /api/college-verification/verify-otp` with `{ "email": "...", "otp": "123456" }`
4. On success the user gets `collegeVerification { verified, collegeId, collegeEmail, method, verifiedAt }`

### Redis keys and TTLs
| Key | Purpose | TTL |
| --- | --- | --- |
| `college-verification:otp:{userId}` | Hashed OTP + email + collegeId + attempts | 300 s |
| `college-verification:resend:{userId}` | Resend cooldown marker | 60 s |
| `college-verification:hourly:{userId}` | Requests in the current hour | 3600 s |

### Limits (enforced server-side)
- 1 OTP request per 60 seconds
- 5 OTP requests per hour per user
- 5 wrong attempts per OTP, then the OTP is deleted
- OTP expires after 5 minutes; a new request replaces the previous OTP
- Successful verification deletes the OTP and resets the counters

### Error codes
`INVALID_EMAIL`, `UNSUPPORTED_COLLEGE_DOMAIN`, `ALREADY_VERIFIED`,
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
    (`redis-cli GET college-verification:otp:{userId}` returns nothing).
13. `redis-cli TTL college-verification:otp:{userId}` never exceeds 300 s, and a wrong
    attempt does not extend it (`KEEPTTL`).
14. Requesting a new code invalidates the previous one.
15. Wait 5 minutes without verifying -> `400 OTP_EXPIRED`.
16. After a successful verify the `otp`, `resend` and `hourly` keys are all deleted.

**Security**
17. Send `{ "email": "you@example.edu.in", "otp": "...", "collegeId": "<someone else's>" }` -
    the supplied `collegeId` is ignored; only the domain-derived college is stored.
18. A different email than the one the code was issued for -> `400 EMAIL_MISMATCH`.
19. A domain that belongs to no college -> `400 UNSUPPORTED_COLLEGE_DOMAIN`.
20. Disable the college (`POST /api/colleges/:id/disable`) and request again ->
    `400 UNSUPPORTED_COLLEGE_DOMAIN`.
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
    domain returns `400 UNSUPPORTED_COLLEGE_DOMAIN` (step 20); Enable restores it.
