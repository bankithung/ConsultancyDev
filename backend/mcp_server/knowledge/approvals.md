# Approval requests: how employees delete and change restricted fields

## Why they exist

Deleting directly needs the deleteRecords capability (managers and up by default, floored at
BRANCH_MANAGER). Everyone else gets 403 "Your role cannot delete records directly. Raise an
approval request instead." The same channel lets an employee propose an update that a manager
then applies, so the audit trail keeps who asked and who agreed.

## Raising one (`create_approval_request`)

Body: `action` (DELETE or UPDATE), `entity_type`, `entity_id`, `message` (why), and for an
UPDATE `pending_changes` — an object of proposed values, whose camelCase keys are converted
server-side.

Valid entity types are enquiry, registration, enrollment, payment, document, task and
follow_up. `appointment` is listed on the model but rejected at validation, and `visa_tracking`
is not an approval type at all, so employees edit their own visa rows directly.

- The target is resolved through YOUR visibility scope: an id you cannot see comes back as
  "That record does not exist." with a 400.
- The request's branch is stamped from the TARGET, not from you, so it lands with the manager
  who controls that record.
- `entity_name` is filled in from the record so the reviewer sees what they are deciding about.

## Reviewing (`approve_approval_request` / `reject_approval_request`)

Needs reviewApprovals. The reviewer's full write scope is re-checked against the LIVE target at
approval time, so a cross-branch review is refused with 403 "You cannot act on that record."
even if the request was routed there. Only PENDING requests can be reviewed.

- DELETE: the record is deleted.
- UPDATE: only the allowlisted keys below are applied and everything else is silently ignored.
  If nothing in the request survives the allowlist the API answers 400 "No permitted fields
  were included in this request."
- The status becomes APPROVED or REJECTED only after the action succeeds, inside a transaction,
  along with `reviewed_by`, `reviewed_at` and `review_note` (sent as the body key `note`).
- If the action fails the whole review rolls back and the request stays PENDING, so it can be
  retried or reviewed again. FAILED is declared on the model but nothing ever writes it: no
  request will come back in that state, and none should be described as failed.

## Allowlisted update fields

| entity_type | fields |
|---|---|
| enquiry | status, course_interested, mobile, email, permanent_address |
| registration | student_name, mobile, email, payment_status, registration_fee |
| enrollment | program_name, status, start_date, duration_months |
| payment | status, method, reference |
| document | type, status, expiry_date |
| task | title, description, status, priority, due_date |
| appointment | status, date, notes (unreachable: see above) |
| follow_up | status, priority, notes, scheduled_for |

Proposing anything outside this table wastes the request. Say what cannot be changed this way
rather than sending it and reporting success.

## Queues

- `approval_pending_count`: requests in my review queue (managers) or my own open ones
  (employees).
- `my_approval_requests`: what I raised.
- `list_approval_requests`: for a manager, both what they raised and what awaits them. It has
  no filterset, so narrow by `ordering` and filter the rows yourself.

## Console behaviour to mirror

When an employee edits an enquiry in the console the form does not save; it raises an UPDATE
request carrying `pending_changes`. Do the same. If an update returns 403 for an employee,
offer `create_approval_request` rather than reporting a failure — and include
`pending_changes`, or the reviewer sees a request with no proposed values and has to guess.

## Known edge

`approval-requests/` is a full ModelViewSet: within your scope a request can be patched or
deleted, and destroy does not consult deleteRecords. Statuses are read-only so nothing can be
self-approved this way, but an already-reviewed row can be rewritten. Use the approve and
reject tools.
