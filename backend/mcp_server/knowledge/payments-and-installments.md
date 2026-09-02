# Payments, installments, refunds and revenue

## Payment (`payments/`)

Fields: `registration` (id or null), `enrollment` (id or null), `installment` (id or null),
`student_name` (writable text), `amount` (decimal >= 0), `date` (datetime, defaults to now),
`type` (free text; the app writes "Registration" and "Enrollment"), `status` (Pending, Success,
Failed, Refunded; default Pending), `method` (free text, default Cash; the console offers Cash,
UPI, Card, Cheque, Bank Transfer), `reference` (<= 120 characters), `metadata` (a JSON object).

- **Only Success counts as revenue** in `payment_stats` and in the analytics. Pending counts as
  pending; Failed and Refunded count as neither.
- `record_payment` requires `metadata` to hold exactly the keys for the method: Cheque →
  `cheque_no` and `bank`; UPI → `upi_id`; Card → `card_last4` and `card_network`; Cash → none.
  Those are the five keys the web console stores and renders, so a payment recorded through
  this server shows its method detail there. The console additionally folds the same detail
  into the flat `reference` string; the API is happy with either or both.
- There is **no registration or enrollment filter** on `payments/`. Per-student payment views
  search by `student_name` and match the foreign key client-side. `student_360` does this for
  you, and warns that a payment written before a rename keeps the old name.
- Filters (multi-value): status, type, method, branch, owner, created_by. Search: student_name,
  reference, type. Ordering: date, amount, status.
- `payment_stats` returns {totalRevenue, thisMonthRevenue, pendingAmount, transactionCount}
  over your scope, cached about 30 seconds per caller.

## The registration fee payment

Created automatically when a registration is created: type Registration, amount equal to
`registration_fee`, status Success only when `payment_status` was "Paid" in any case. To take a
registration fee later, patch the registration's `payment_status` and record a payment against
it. Creating a second payment for the same fee is the most common double-entry mistake here.

## Installments (`installments/`)

Built by the server from `installments_count` on enrollment create; never construct a schedule
yourself. The amounts sum exactly to `total_fees` — the last row absorbs the remainder, so a
1000 split three ways totals 1000 and not 999.99 — and the due dates step whole calendar
months from `start_date` rather than 30-day blocks.

Settle one with `record_payment` (set `enrollment` and `installment`), then `update_installment`
{status: "Paid", paid_at}. The console's "payment arrangement" label is derived rather than
stored: more than one installment reads as Installments, otherwise Full payment.

`installments/` lists and reads but has no filters at all; read them nested inside the
enrollment, or through `student_360`.

## Refund (`refunds/`)

Fields: `student` (registration id, required), `payment` (id or null), `amount` (>= 0),
`reason`, `status` (Pending, Approved, Processed, Rejected), `processed_at`. Reading is open to
the tenant within scope; writing needs manageRefunds (managers and up by default, with no
floor, so a company may delegate it further). A refund counts as settled at Approved or
Processed. Filters (multi-value): status, student, payment, branch, owner, created_by.

## Totals a client must compute

- paid = the sum of Success payments; pending = the sum of Pending; refunded = the sum of
  Approved and Processed refunds; net = paid minus refunded.
- Net income on the payments screen is `payment_stats` totalRevenue minus Processed refunds.
- `student_360` returns totals {paid, pending, refunded, net, total_fees,
  outstanding_installments} already computed, and is the cheaper answer for one student.

## Money formats

Decimals travel as strings ("1500.00"). Send a string or a number; read them as decimals, never
as floats you then round. Currency is INR throughout and there is no currency field on a
payment, so never label an amount in anything else.
