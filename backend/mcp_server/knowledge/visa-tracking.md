# Visa tracking

## The record (`visa-tracking/`)

Fields: `student` (a registration id or null), `student_name` (text, searchable), `passport_no`
(**encrypted**; a blind index exists server-side but is not exposed as a filter), `country`,
`visa_type`, `applied_date` (date), `current_stage`, `interview_date`, `expected_decision`
(date), `officer`, `notes`, and `status` (free text, default "In Progress").

## Stages, in order

Documents → Applied → Biometrics → Interview → Decision → Approved or Rejected.

- The console shows progress as the stage index over 6, and a success rate of Approved over
  Approved plus Rejected. Both are derived in the client, not returned by the API.
- `analytics_visa_pipeline` returns counts for all seven stages plus a total, scoped to the
  caller, and is open to every active user rather than gated on viewAnalytics.
- The Approved stage is the last step of `analytics_funnel`, so a stalled visa pipeline shows
  up there as enrollment-to-visa drop-off.

## Rules

- Filters (single-value exact): current_stage, status, branch, country. Search: student_name,
  country, visa_type. Ordering: created_at, current_stage, interview_date.
- Passport numbers cannot be searched, filtered or sorted through the API, because the column
  is encrypted. Ask for the student's name instead, or resolve the registration first.
- Transferable (entity type visa_tracking). NOT approval-eligible: `visa_tracking` is not one
  of the approval entity types, so an employee edits their own visa rows directly and cannot
  route a change through a manager.
- The console's visa page is hidden from the sidebar but fully functional. It never sends
  `notes` and hard-codes `status`, so rows created through this server can legitimately be
  richer than rows created there — do not treat the extra fields as anomalies.

## Typical updates

- Move a stage: `update_visa_tracking` {current_stage: "Interview", interview_date:
  "2026-10-04T10:00:00Z"}.
- Record the decision: {current_stage: "Approved", status: "Approved"}, or the same with
  Rejected. `current_stage` drives the analytics; `status` is free text for humans.
- Link to the student: set `student` to the registration id. Then `student_360` finds the visa
  row by foreign key instead of by name, which is the difference between a reliable answer and
  a name match.

## Privacy

`passport_no`, and dates of birth on enquiries and registrations, are encrypted at rest with
the company-wide field key; only the API returns them in clear. Disk encryption would not have
helped against a leaked dump or an over-broad query, which is what this defends.

Never copy a passport number or a date of birth into `notes`, `remarks`, a task title or a
follow-up comment. Those columns are plain text, they are searchable, and they are visible to
everyone whose scope covers the record. If a user asks you to record one somewhere else, say
why you are putting it on the visa row instead.

There is no key-rotation command. Rotating the field key means re-encrypting every row and
blob by hand, so treat the current key as long-lived and the data as needing care.
