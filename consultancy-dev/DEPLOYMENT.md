# Frontend deployment checklist

Short list of the things that fail *silently* if they are wrong. Everything here
has a failure mode that looks like "the app is broken" rather than pointing at
its own cause, which is why it is written down.

## 1. `NEXT_PUBLIC_API_URL` must match the real API origin exactly

Used for two separate things:

1. the axios base URL (`lib/api.ts`)
2. the CSP `connect-src` allow-list, baked in at **build time** (`next.config.ts`)

**The failure mode:** if this value does not match the origin the browser
actually requests, the browser blocks every API call *before it hits the
network*. You get a completely dead app — no data, no login — with nothing in
the Network tab and only a CSP violation in the console. Nobody debugging this at
2am connects it to a header, because the app was never touched.

Because `connect-src` is compiled in, **changing this variable requires a
rebuild**, not just a restart. Setting it in a runtime-only env panel will not
update the CSP.

Check after any deploy that changes the API host:

```bash
curl -sI https://your-frontend/login | grep -i content-security-policy
```

`connect-src` must contain the exact scheme+host+port the frontend calls.
Mismatches to watch for: `http` vs `https`, a missing port, `localhost` vs
`127.0.0.1`, and an apex domain vs `www`.

## 2. `JWT_PUBLIC_KEY_B64` must match the backend keypair

Copy the backend's `JWT_PUBLIC_KEY_B64` verbatim (base64-encoded PEM; raw PEM
also works). The backend signs RS256 with the private half, which never leaves
it.

- Server-only. Do **not** prefix with `NEXT_PUBLIC_`.
- If it is missing or malformed, role-gated routes **fail closed** — every
  gated route redirects to `/app/forbidden`, including for admins. Look for
  `[proxy] No JWT verification key configured` or
  `[proxy] JWT_PUBLIC_KEY_B64 is not a valid public key` in the server logs.
- `JWT_VERIFY_SECRET` is a **dev-only** HS256 fallback, for a `DEBUG=True`
  backend running without a keypair. Leave it unset in production: a shared
  symmetric secret would let the frontend mint tokens too. It is ignored
  whenever the public key is set.

## 3. Verify the edge auth gate is actually loaded

`proxy.ts` must export a function named **`proxy`**. Next discovers it by name,
so a file exporting `middleware` (the pre-Next-16 name) is silently inert: it
typechecks, it builds, and every gated route renders unguarded. A green build
proves nothing here.

After any rename, upgrade or routing change, confirm all three:

```bash
# 1. unauthenticated -> 307 to /login, carrying ?from= and ?reason=
curl -sI https://your-frontend/app/dashboard | grep -i '^HTTP/\|^location'

# 2. valid token, insufficient role -> 307 to /app/forbidden
curl -sI --cookie "auth-token=<EMPLOYEE_ACCESS_TOKEN>" \
  https://your-frontend/app/dev-tools | grep -i '^HTTP/\|^location'

# 3. valid token, sufficient role -> 200
curl -sI --cookie "auth-token=<DEV_ADMIN_ACCESS_TOKEN>" \
  https://your-frontend/app/dev-tools | grep -i '^HTTP/'
```

If #1 returns 200, the gate is not running at all — check the export name and
the filename before looking anywhere else.

## 4. The access token must carry a `role` claim

The gate reads `role` from the JWT. The backend adds it in
`RoleTokenObtainPairSerializer.get_token()`; SimpleJWT copies it onto the
access token derived on refresh, so login and rotation are both covered.

If it is ever removed, every role-gated route denies every user and the server
log says so explicitly (`[proxy] Token verified but carries no usable 'role'
claim`). Decode a token from `POST /api/auth/login/` to confirm:

```bash
# claims should include role, and (currently) company and branch
```

These claims are for routing and UI only — every authorization decision is made
server-side against the database.

## 5. Expected user-visible behaviour after an admin edits an account

The backend blacklists a user's outstanding refresh tokens whenever their role,
branch, company or active status changes. That user's next refresh returns 401
and they are signed out immediately, rather than carrying stale claims for the
full refresh lifetime.

This is intended, not a bug. Two consequences worth knowing before someone
reports them:

- The sign-out can land mid-action, so an in-flight save may be lost.
- They return to `/login?from=…&reason=session_ended`, which renders
  "Your session ended because your account was changed" rather than a bare
  sign-in form.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | yes | Public. Baked into the CSP at build time — rebuild after changing. |
| `JWT_PUBLIC_KEY_B64` | yes (prod) | Server-only. Must match the backend keypair. |
| `JWT_VERIFY_SECRET` | no | Dev-only HS256 fallback. Leave unset in production. |
| `NEXT_PUBLIC_APP_URL` | no | Frontend's own public URL. |
