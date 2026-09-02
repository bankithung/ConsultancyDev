# Record transfers: handing a record to a colleague

## What a transfer is

A **RecordTransfer** moves custody of one record from `from_user` to `to_user`. On acceptance
the record's `owner` becomes the recipient, its `branch` moves to the recipient's branch when
the two differ (so branch-scoped managers keep a consistent picture), and `assigned_to` is
updated where the model has it (tasks, follow-ups). `created_by` never changes: it is an audit
trail, not a grant. **The sender loses access**, because an employee sees only what they own.

Tell the user that before you send one. A transfer is not a share.

## Transferable entity types

enquiry, registration, enrollment, document, task, follow_up, visa_tracking.

Payments, appointments, templates, agents, installments, comments, remarks and student
documents cannot be transferred. Payments are the trap: the viewset declares an entity type of
payment, but payment is not on the transferable list, so the inheritance branch can never
match for them.

## Creating one (`create_transfer`)

Body: `entity_type`, `entity_id`, `to_user` (a user in your company, and not yourself), `note`.
The actor must be able to WRITE the target. When they cannot, the API answers as if the record
did not exist ("That record does not exist."), so a transfer cannot be used to probe for ids.

- Dev admins, company admins, head managers and branch managers transfer with no acceptance
  step: the move is applied immediately and the row comes back ACCEPTED.
- Employee to employee stays PENDING until the recipient accepts, so nobody can silently push
  their work onto a colleague.

## Resolving one

- `accept_transfer` and `reject_transfer` are for the recipient only, and only while PENDING.
  Anyone else gets 403 "Only the recipient can accept a transfer."; an already-resolved
  transfer gets 400.
- A transfer whose target has since been deleted is marked CANCELLED when it is applied, rather
  than failing.

## Listing

- `transfer_inbox`: PENDING transfers addressed to me — the queue to act on.
- `transfer_outbox`: everything I sent, whatever its status.
- `list_transfers` filters (single-value exact): status, entity_type, from_user, to_user.
  Managers see transfers in their branches plus their own; employees see only their own.

## Visibility lag

Accepting a transfer is not part of the cached scope signature, so analytics and `payment_stats`
can lag by up to 30 seconds afterwards. Lists are never cached, so re-reading the record itself
is immediately correct.

## Known edge

`transfers/` is a full ModelViewSet with no extra guards: a transfer you can see can also be
patched or deleted, and destroying one does not consult deleteRecords. Status is read-only, so
a transfer cannot be flipped to accepted that way, but history can be rewritten. Prefer
`accept_transfer` and `reject_transfer`, and do not delete transfer history.

## Physical documents are not transfers

Custody of a paper original is tracked on the student document instead: patch `current_holder`
and note the handover in `remarks`. Sending a `transfer` for it will fail, because
student-documents is not a transferable entity type.
