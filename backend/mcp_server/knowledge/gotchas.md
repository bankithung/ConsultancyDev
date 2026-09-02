# Gotchas, traps and known gaps

Facts an AI client must know to avoid wrong answers or broken writes. Everything here was
observed against the running backend, not inferred from the models.

## Endpoints that do not do what their shape suggests

- **POST installments/ cannot work.** `enrollment` is read-only on the serializer while the
  column is not nullable, so a create fails and surfaces as 409. There is no create tool for
  installments. They come only from an enrollment create with `installments_count`.
- **POST branches/ as a DEV_ADMIN answers 500**, because the create stamps the caller's company
  and a dev admin has no company. Create branches as a company admin.
- `appointment` is a valid approval entity type on the model but is rejected at validation, so
  it is dead. Conversely `visa_tracking` is resolvable as a transfer target but is not an
  approval type at all.
- `payments/` has no registration or enrollment filter; `documents/` DOES filter by
  registration and enquiry; `follow-ups/` DOES filter by assigned_to; `tasks/` has no due_date
  filter; `branches/`, `universities/`, `commissions/`, `agents/`, `templates/`,
  `approval-requests/` and `installments/` have no filterset at all.
- `installments/` lists fine but has no filters; read installments nested in the enrollment.
- Bare arrays instead of the pagination envelope: `users/counselors/`, `appointments/calendar/`,
  `analytics/branches/`, `analytics/sources/`, `plans/`.

## Authorization edges

- Shared universities (company null) are writable by any manager in any tenant.
- Transfers and approval requests can be patched or deleted within your scope, and neither
  destroy consults deleteRecords. Statuses stay read-only, so nothing can be self-approved that
  way. Prefer the accept, reject, approve and reject tools.
- Any Django superuser is treated as a DEV_ADMIN, whatever their role column says.
- Records created by a DEV_ADMIN through the scoped viewsets land with company and branch NULL
  and are then invisible to every tenant, including the one they were meant for.
- `payment` is not transferable even though the viewset names it as an entity type. Comments,
  remarks, templates, appointments, agents, installments and student documents are never
  inherited by a transfer either.
- Login mints a token pair before checking that the account is an active employee. The client
  never receives them, but the attempt is recorded.

## Data shape traps

- Approval request statuses are UPPERCASE on the wire (PENDING, APPROVED, REJECTED, FAILED)
  while the console's own type says title case. FAILED is real and means the action was
  attempted and did not succeed.
- Older `preferred_locations` values may be JSON-encoded strings rather than lists. They read
  fine but do not match the `preferred_locations` filter, so a filtered count can be short.
- A registration has real profile columns (gender, marks, schooling), but the console form
  writes those details into `student-remarks/` as free text instead. Use the columns;
  `student_360` shows both so you can see the disagreement.
- Three payment vocabularies coexist in the console (types Registration, Enrollment, Other;
  methods Cash, UPI, Card, Cheque, Bank Transfer, Online) and two document type lists (7 values
  and 10). The API accepts any text for all of them.
- The console's own types for tasks and payments lag the wire. Trust the API.

## Operational

- Row locking is a no-op on SQLite in development, so two concurrent registration creates can
  collide on the reference number and surface as 409. Retry once.
- Without Redis, throttle counters and the capability cache are per worker: the effective
  throttle is a multiple of the configured rate, and a permission change can take up to 300
  seconds to be seen everywhere.
- Analytics and `payments/stats/` are cached 30 seconds per caller and report it in the
  `x-cache` header. Accepting a transfer and changing a head manager's managed managers are not
  part of the cache key, so they lag by that long.
- `/api/health/` is open but throttled at 30/min for anonymous callers.
- A document URL time-to-live setting exists and nothing reads it: there are no signed URLs.
- There is no key-rotation command for the encrypted fields; rotating means re-encrypting rows
  and blobs by hand.

## Console-only features with no API behind them

No enquiry convert endpoint (it is a client-side flow). No task history. No document audit log.
No per-employee earnings. No notification create. No template send. The student portal page is
a static mock.

## Safe defaults for an AI client

- Confirm before every delete, reset, reject, revoke or deactivation, and say what it affects.
- Omit reference numbers and let the server assign them.
- Never put passport numbers or dates of birth into free-text fields.
- Use `explain_permission` before promising a user that an action will work, and
  `my_capabilities` for what their role holds right now.
