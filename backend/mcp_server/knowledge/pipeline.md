# The admissions pipeline, step by step

## 1. Enquiry (`enquiries/`)

Required on create: `school_name`, `stream`, `course_interested`, `mobile`, `email`,
`father_name`, `mother_name`, `permanent_address`. Everything else is optional:
`candidate_name`, parents' occupations and mobiles, `preferred_locations` (a JSON list of place
names), `other_location`, the profile block (`gender`, `date_of_birth` (encrypted), `caste`,
`religion`, `family_place`, `family_state`), class 12 and class 10 schooling, subject marks and
the derived `pcb_percentage` and `pcm_percentage`, NEET marks, gap-year flags, `payment_amount`.

The web form computes each percentage as the mean of the three subject marks and writes it
back; compute them the same way if you set marks, or the two clients disagree.

Status: New, Contacted, Converted, Closed. `date` and `created_at` are server-set and cannot be
supplied. Filters (multi-value): status, stream, course_interested, gender, caste, school_board,
family_state, preferred_locations, branch, owner, created_by. Search: candidate_name,
school_name, mobile, email, course_interested.

## 2. Follow-ups (`follow-ups/`) and comments (`follow-up-comments/`)

See `follow-ups-and-appointments`. A lead with no follow-up scheduled is the one worth flagging.

## 3. Registration (`registrations/`)

Required: `student_name`, `registration_fee` (decimal, >= 0). Usual: `mobile`, `email`,
`date_of_birth`, parents, `permanent_address`, `needs_loan`, `payment_status` (free text,
default "Pending"; "Paid" makes the automatic payment Success), `payment_method` (default Cash),
`preferences` (a JSON list of {courseName, location, priority}), `enquiry` (optional FK, but set
it when converting), and the same profile and schooling block as Enquiry.

Side effects on create: `registration_no` becomes REG-YYYY-NNN per company (omit it), and a
**Payment** row of type Registration and amount `registration_fee` is created — status Success
when `payment_status` is "paid" case-insensitively, otherwise Pending. Do not also record that
payment yourself; it already exists.

Conversion: `convert_enquiry_to_registration` copies the enquiry into a registration, links
`enquiry`, then patches the enquiry to Converted. There is no server-side convert endpoint, so
doing it by hand means both steps or a half-converted lead.

## 4. Enrollment (`enrollments/`)

Required: `student` (a registration id in your company), `program_name`, `start_date`
(YYYY-MM-DD), `duration_months`, `total_fees`. Optional: `university` (id, own or shared
catalogue), `university_name`, `country`, `commission_amount`, `status` (free text, default
Active).

Write-only helpers: `installments_count` (>= 0) and `installment_amount`. The server builds
Installment rows that sum exactly to `total_fees` (the last row absorbs the rounding), due at
whole calendar months from `start_date`. `enrollment_no` becomes ENR-YYYY-NNN when omitted.
Creating an enrollment notifies the company admins and the branch manager — the only
notification trigger in the system.

## 5. Installments (`installments/`)

Read-only in practice. There is no create tool, because `enrollment` is read-only on the
serializer and a direct POST fails with 409. Fields: number, due_date, amount, status (default
Pending), paid_at. Mark one paid with `update_installment` {"status": "Paid", "paid_at": ...}
and record the money with `record_payment` linking `installment`.

## 6. Payments and refunds

See `payments-and-installments`. Only Success counts as revenue.

## Ownership through the pipeline

Each record is owned by whoever created it, or by whoever received it in a transfer. A
registration created from an employee's enquiry is owned by that employee; `created_by` stays
as the immutable author and grants nothing. Managers see the whole branch regardless.

## Typical sequences

- New lead: `create_enquiry` → `create_follow_up` (scheduled_for) → after the call
  `update_follow_up` {status, outcome_status, admission_possibility, notes}.
- Signing up: `convert_enquiry_to_registration` → `upload_document` /
  `create_student_document` → `enroll_student` → `record_payment`.
- Checking on a student: `student_360`, which gathers the registration, enrollments,
  installments, payments, refunds, documents, visa rows and remarks in one call.
