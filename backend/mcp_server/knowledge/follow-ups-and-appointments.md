# Follow-ups, comments, appointments and tasks

## Follow-up (`follow-ups/`)

A scheduled touchpoint on an enquiry. Fields: `enquiry` (required), `assigned_to` (a user id or
null), `scheduled_for` (datetime, required), `type` (free text, default Call; the console uses
Call, Visit, Email, WhatsApp), `status` (free text, default Pending; the console uses Pending,
Completed, Missed), `priority` (free text, default Medium), `notes`, `completed_at`,
`outcome_status` (Not reached, Interested, Thinking, Not interested, Converted) and
`admission_possibility` (High, Medium, Low, Unknown).

- Completing one in the console patches status Completed, `completed_at`, `outcome_status` and
  `admission_possibility`, and APPENDS a "--- Completed <date> ---" block to `notes` rather
  than overwriting them. Do the same: the notes field is the call history.
- `outcome_status` says what happened on the call; `admission_possibility` says how likely the
  lead now is. They are different questions and both are worth setting.
- Filters (multi-value): status, priority, type, outcome_status, admission_possibility,
  assigned_to, enquiry, branch, owner. Search: the enquiry's candidate name, mobile and email,
  plus notes. Ordering: scheduled_for, status, priority, created_at.
- Transferable, and approval-eligible for status, priority, notes and scheduled_for.

## Follow-up comment (`follow-up-comments/`)

An append-only thread between counsellor and manager: `follow_up` and `comment`, with `author`
stamped server-side. Update and delete both answer 403 by design, so a comment is permanent —
say so before writing one. Filter: follow_up. Ordering: created_at.

## Appointment (`appointments/`)

Fields: `student_name`, `student_email`, `counselor` (a user id, required), `date` (datetime,
required), `time` (an optional time), `duration` (minutes, default 60), `type` (In-Person,
Video Call, Phone Call), `status` (Scheduled, Completed, Cancelled), `notes`.

- `appointments_calendar` {month, year} returns an UNPAGINATED array for that month after the
  usual search and filters. It is the right call for "what is on today".
- Filters (multi-value): status, type, counselor, branch, owner, created_by. Search:
  student_name, student_email. Ordering: date, status.
- Not transferable, and approval requests naming an appointment are rejected at validation, so
  employees change appointments directly within their own scope.
- There is no link to a registration: an appointment is matched to a student by name, and two
  students with one name cannot be told apart here.

## Task (`tasks/`)

Fields: `title`, `description`, `assigned_to` (a user id, required), `due_date` (datetime,
required), `priority` (free text, default Medium), `status` (free text, default Todo; the
console board uses Todo, In Progress, Done), `completed_at`, `position` (the kanban order).

- `reorder_tasks` {ids: [...], status?} writes `position` in the order given; with `status` it
  also moves those tasks to that column and stamps `completed_at` when the column is Done. Ids
  outside your scope are skipped silently, so check the result rather than assuming.
- Filters (single-value exact): status, assigned_to, priority, branch. Search: title,
  description. Ordering: due_date, priority, status, position.
- There is **no due_date filter**, so overdue and due-today counts have to be computed over the
  rows you fetched. Say how many rows that was if the list was truncated.
- Transferable — accepting reassigns `assigned_to` — and approval-eligible.

## Reminders

The console's upcoming-reminders widget is follow-ups due plus appointments for the counsellor,
filtered in the browser because `appointments/` has no counselor filter it can use there.
`daily_briefing` reproduces the same view server-side and is the one call to make first.
