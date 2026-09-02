# API conventions every call must follow

## Paths and verbs

- Base `/api/`, with a trailing slash on every path (`enquiries/`, `enquiries/5/`,
  `documents/5/download/`). Without it the router redirects and a POST body is lost.
- Standard verbs per resource: GET list, POST create, GET detail, PATCH partial update
  (preferred), PUT full update, DELETE. Custom actions are POST or GET at `resource/{id}/action/`
  or `resource/action/`.

## Authentication

- Personal API key: `Authorization: Bearer cdk_...` (or the `X-API-Key` header). It inherits
  the user's role and scope exactly. Keys are created on the Profile page of the console, or
  through the API under password credentials; **there is no create tool here**.
- Every `api-keys` endpoint answers 403 to a caller who authenticated with an API key. So
  `list_api_keys` and `revoke_api_key` work only when this server is running on a username and
  password, which is the point: a stolen key cannot enumerate or revoke its siblings.
- JWT: POST `auth/login/` {username, password} returns {access, refresh, user}. The access
  token lives 15 minutes by default and the refresh 7 days with rotation, so POST
  `auth/refresh/` returns a NEW refresh and blacklists the old one. POST `auth/logout/`
  {refresh} ends the session.
- Changing a user's role, branch, company, password or active flag revokes all of their tokens
  and keys immediately.

## Pagination

The envelope is {count, pages, page, page_size, next, previous, results}. `page_size` defaults
to 25 and caps at 200.

Bare arrays with no envelope: `users/counselors/`, `appointments/calendar/`,
`analytics/branches/`, `analytics/sources/` and `plans/`. Plain objects: the other analytics
endpoints and `payments/stats/`.

## Filtering, search, ordering

- `search=` matches that resource's search fields, which are listed in its schema.
- `ordering=field` or `ordering=-field`, only from the resource's ordering fields.
- Multi-value filters need the key **repeated** (`?status=New&status=Contacted`); pass a list
  to the tool. A comma-joined string matches nothing, and values here really do contain commas
  ("SEBA (Board of Secondary Education, Assam)").
- Plain filterset fields — on documents, tasks, users, visa-tracking, transfers, comments,
  remarks and student-documents — are single-value exact matches.
- Unknown filter parameters are silently ignored by the API. The tools here reject them
  instead, so a list you asked to filter is never quietly unfiltered.
- Encrypted fields cannot be filtered, searched or sorted: `date_of_birth` on enquiries and
  registrations, `passport_no` on visa tracking.

## Errors

Always {"error": "<message>"}, or {"error": "Validation failed", "fields": {...}} for a 400.
There is never a DRF `detail` key on the wire.

- 403 on a delete means raise an approval request; 403 otherwise is a missing capability.
- 404 means "not found OR outside your scope" and the API never says which. The wording varies
  and can be Django's own "No <Model> matches the given query."
- 409 is a unique-value collision. 429 is a throttle. Status 0 is not an API answer at all: it
  means the backend could not be reached.

## Throttling (production)

Anonymous 30/min, user burst 120/min, user 5000/hour, login 8/min, signup 5/hour. Locally these
are far higher. A 429 is retried once automatically, honouring `Retry-After`; beyond that, slow
down and use a larger `page_size` rather than more requests.

## Formats

- Datetimes are ISO 8601 with a timezone (2026-09-02T09:00:00Z); dates are YYYY-MM-DD;
  decimals are strings ("1500.00"); booleans are true/false; JSON fields are real JSON.
- Header names are case-insensitive and are normalised to lowercase here, so read `x-cache` and
  `retry-after` in lowercase.
- Server-owned on every scoped record: company, branch, `created_by`, `owner`, `created_at`,
  `updated_at`. Sending them is ignored rather than refused.
- Reference numbers `registration_no` and `enrollment_no` are assigned when omitted. Omit them.

## Uploads

`documents/` accepts multipart/form-data with a `file` part. Allowed extensions: pdf, png, jpg,
jpeg, webp, doc, docx, xls, xlsx. Maximum 10 MB by default. Both create and update are
multipart when a file is attached; metadata-only writes may be JSON.
