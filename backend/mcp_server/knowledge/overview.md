# ConsultancyDev: what the system is and how to work it

ConsultancyDev is a CRM for an education and immigration consultancy: medical and engineering
admissions in India (NEET, PCB/PCM streams), university placement abroad, and visa tracking. A
Django REST API at `/api/` is the only backend; a Next.js console is one client of it, and this
MCP server is another. Anything the console can do, it does through the same endpoints these
tools call, so what you read here is the whole system rather than a projection of it.

## Tenancy and people

- A **Company** is a tenant. It owns **Branches** (e.g. Head Office, Kohima, Dimapur). Every
  operational record carries `company`, `branch`, `created_by` (immutable author) and `owner`
  (current custodian).
- Five **roles**: DEV_ADMIN (platform operator, no company), COMPANY_ADMIN, HEAD_MANAGER
  (oversees a configurable set of branch managers), BRANCH_MANAGER, EMPLOYEE. See
  `roles-and-visibility`.
- Capabilities (manageUsers, deleteRecords, reviewApprovals, ...) are granted to a ROLE per
  company through the permissions matrix; never to an individual.

## The pipeline

1. **Enquiry**: a lead (candidate, school, marks, preferred locations). Status New, Contacted,
   Converted, Closed.
2. **Follow-ups**: calls and visits scheduled against an enquiry, with an outcome and an
   admission likelihood, plus an append-only comment thread.
3. **Registration**: the student signs up. The server assigns `registration_no` (REG-YYYY-NNN)
   and creates the registration-fee **Payment**.
4. **Enrollment**: a program at a university. The server assigns `enrollment_no` (ENR-YYYY-NNN)
   and builds **Installments** from `installments_count`.
5. **Payments** and **Refunds** move money; only Success payments count as revenue.
6. Around the student: uploaded scans (**Documents**), custody of paper originals (**Student
   documents**), **Visa tracking** stages, **Appointments**, **Tasks**, **Remarks**.

## Working rules an AI client must respect

- You act AS one user. Everything you see and change is limited to that user's scope. `whoami`
  tells you who, and `my_capabilities` tells you what that role holds right now.
- Read `consultancy://schema/<resource>` before creating or updating: it lists required fields,
  choices and read-only fields.
- Conversion from enquiry to registration is not an endpoint; it is a registration create with
  `enquiry` set (`convert_enquiry_to_registration` does it and then marks the enquiry Converted).
- Employees cannot delete directly and cannot edit some fields freely: they raise an **approval
  request** for a manager. Offer `create_approval_request` when a write is refused with 403.
- Transfers **move** ownership; the sender loses the record.
- Never fabricate reference numbers, amounts or statuses; ask when unsure and confirm before
  writes. Omit `registration_no` and `enrollment_no` entirely and let the server allocate them.
- Multi-value filters are lists (repeated query keys). Comma-separated values match nothing.
- Analytics and payment totals are cached about 30 seconds per caller, so your own write will
  not move your own counters immediately. Lists are always live.

## Where to look

- `consultancy://catalog` — machine-readable everything (resources, fields, filters, actions).
- `consultancy://api-reference` — the same as prose.
- `consultancy://schema/<resource>` — one resource in detail.
- `consultancy://me` — who you are, right now, with live capabilities.
- `consultancy://knowledge/<topic>` — this series: roles-and-visibility, pipeline,
  payments-and-installments, documents, transfers, approvals, follow-ups-and-appointments,
  visa-tracking, commissions, universities-and-templates, notifications, analytics,
  api-conventions, gotchas.

## Start here

`whoami`, then `daily_briefing` for what needs attention today, then `student_360` for one
student or `search_everything` when you only have a name. Read `gotchas` before you write
anything unusual: several endpoints do not do what their shape suggests.
