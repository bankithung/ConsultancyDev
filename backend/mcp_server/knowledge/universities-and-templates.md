# Universities, templates, branches and companies

## University (`universities/`)

A catalogue entry rather than a tenant-scoped record: it carries `company` (null means shared
with every tenant) and has no branch and no owner. Fields: `name`, `country`, `city`,
`ranking`, `programs` (a JSON list), `tuition_fee_min`, `tuition_fee_max`,
`admission_deadline` (free text), `requirements` (a JSON list) and `rating` (0 to 5).

- Reading: everyone in the tenant sees their own rows plus the shared ones. Writing: managers
  and up, with no capability gate. Creating always stamps your own company, so you cannot add
  to the shared catalogue by accident.
- Search: name, country, city. Ordering: name, ranking, rating. There is no filterset, so
  country and program filtering happens client-side after walking the pages.
- Known gap: a shared row (company null) is writable cross-tenant by any manager in any tenant,
  because the viewset defines no object-level check. Do not edit or delete a shared row unless
  the user explicitly asks, and tell them it affects every tenant.
- An enrollment references a university by `university` and also carries `university_name` and
  `country` as text. "Students per university" is only answerable by scanning enrollments.

## Template (`templates/`)

Message templates: `name` (unique per company), `template_type`, `category` (Email, SMS,
WhatsApp), `subject`, `content` (required), `variables` (a JSON list of placeholder names) and
`is_active`. Search: name, subject, content.

There is **no send endpoint** anywhere in the backend. A template is text that staff copy into
their own channel. The console page is built but hidden from the sidebar, its edit button does
nothing, and it always sends the active flag as true. Never offer to send a message.

## Branch (`branches/`)

Fields: `name`, `code`, `city`, `address`, `phone`, `is_active`, plus the read-only
`is_default`, `company`, `user_count` and `manager_names`. Everyone reads them, because every
picker needs the list; writing needs manageBranches, and creating additionally requires being a
company admin.

The default branch cannot be deleted, and neither can a branch that still has users. A record
created by a user with no branch lands in the company's default branch. Search: name, code,
city. No filterset and no ordering fields.

## Company (`companies/`)

A dev admin sees and manages all of them. A company admin sees only their own row — any other
id answers 404 — and may edit name, email, phone and address. Create and destroy are refused
for everyone but a dev admin, with a message saying so. Provisioning a company creates a "Head
Office" default branch and an active subscription in the same transaction.

## Signup requests (`signup-requests/`)

An anonymous prospect posts {company_name, admin_name, email, phone, plan, username, password,
first_name, last_name}. Only a DEV_ADMIN lists them, approves one with `approve_signup_request`
(which provisions the company, its branch, its subscription and the COMPANY_ADMIN account from
the password captured at submission) or rejects it. The public signup entry point in the
console is currently hidden.

## Reference data the console hard-codes

Country lists, program lists, document type lists, rating scales and preferred-location hubs
are literals in the frontend, not API resources — and several of them disagree with each other
between screens. The API accepts free text for all of them, so use the values you can see in
existing rows rather than inventing a vocabulary, and never present one of these lists as if
the server enforced it.
