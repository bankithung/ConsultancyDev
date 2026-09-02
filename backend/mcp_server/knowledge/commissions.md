# Agents and commissions

## Agent (`agents/`)

A referral partner. Fields: `name`, `email`, `phone`, `commission_type` (free text, default
Percentage), `commission_value` (decimal), `status` (free text, default Active), plus three
read-only aggregates: `total_earned` (the sum of Paid commissions), `pending_amount` (the sum
of Pending) and `students_referred` (distinct students).

The aggregates are recomputed by database signals whenever a commission is saved or deleted.
There is no manual recompute and no way to write them directly, so an agent row that looks
wrong means the commissions behind it are wrong.

Access: reading AND writing both need manageCommissions (admins by default, floored at
HEAD_MANAGER). A head manager who can see earnings still cannot list agents unless the company
granted them the capability. Search: name, email. No filterset.

## Commission (`commissions/`)

Fields: `agent` (required), `student` (a registration id or null), `enrollment` (id or null),
`enrollment_fee`, `commission_amount` (required, at least 0.01 — "A commission must be worth
more than nothing."), `status` (Pending, Paid) and `paid_at`.

- Reading needs viewEarnings (admins plus head manager by default, floored at HEAD_MANAGER);
  writing additionally needs manageCommissions. Deleting one needs both that write capability
  and deleteRecords, which is why `explain_permission` reports two gates for it.
- Mark one paid with `update_commission` {status: "Paid", paid_at: ...}. A partial update does
  not re-require agent or amount.
- Ordering: created_at, commission_amount, status. There is no filterset and no search, so list
  and narrow the rows yourself.

## Earnings screens

- Company earnings is the revenue analytics, not a separate resource. A DEV_ADMIN additionally
  sees a platform monthly recurring revenue figure computed from subscription period dates — an
  acknowledged approximation, because historical status changes are not stored.
- **Per-employee earnings do not exist.** Commissions attach to an agent, not to a member of
  staff, so "how much did this counsellor earn" has no answer in this system. Say that rather
  than summing something adjacent.

## Enrollment commission

`Enrollment.commission_amount` is a separate figure recorded on the enrollment itself, default
0. `analytics_revenue` reports commissions from the Commission table and not from enrollments,
so the two can disagree and neither is wrong.

## Subscriptions and plans (related money, currently inert)

`plans/` is a public catalogue: Starter (free), Growth (2999) and Scale (7999).
`subscriptions/` is read-only, and `get_my_subscription` returns the company's row.

Plan limits are advertised and **not enforced**. The seat and branch checks still run and still
count, but they can never refuse, and the subscription permission class always passes. Never
tell a user they have hit a plan limit; nothing in the backend will ever say so.
