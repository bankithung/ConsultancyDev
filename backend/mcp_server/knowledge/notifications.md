# Notifications

## What they are

Per-user tray items: `title`, `message`, `type` (info, success, warning, error), `is_read`,
`action_url` (a console path such as /app/enrollments/12) and `created_at`. Over the API they
are read-only apart from marking them read. Each row belongs to exactly one recipient; there is
no shared feed and no broadcast.

## What creates them

Only server-side signals. Today there is exactly **one** trigger: a new **enrollment** that has
a company notifies every active COMPANY_ADMIN of that company plus the BRANCH_MANAGER of the
enrollment's branch. The row is titled "New enrollment", its message is
"<enrollment_no> — <program_name>", and its type is success.

Creating a registration writes a log line and nothing else. Nothing at all notifies on
follow-ups falling due, approval requests, transfers, expiring documents or overdue
installments. `daily_briefing` covers those by querying, which is why it exists.

## Tools

- `list_notifications` — your own rows only, newest first. There are no filters.
- `unread_notification_count` returns {count}. The console polls it every 60 seconds.
- `mark_notification_read` {id} and `mark_all_notifications_read`, which returns {updated}.

There is no create tool and no delete tool, because the endpoint has neither.

## Limits worth stating plainly

- You cannot create a notification for anyone, including yourself. The viewset exposes no
  create and the recipient field is not writable. That is deliberate: an earlier version let a
  caller plant an `action_url` in an administrator's tray, which is a phishing primitive.
- Delivery is by polling. The WebSocket layer was removed, so "real time" here means "within
  the client's poll interval".
- The Notify button on the document-expiry screen is permanently disabled for the same reason.

## When a user asks "did anyone get told?"

Answer from this list. An enrollment was created, so the company admins and that branch's
manager were notified immediately. Anything else, and nobody was told automatically.

The in-app ways to leave a message for a colleague are a task (`create_task` with `assigned_to`
set to that person, and a `due_date`, which is required) or a comment on a follow-up
(`create_follow_up_comment`, which is append-only and permanent). Both are visible work items
rather than notifications, so say which one you used and that the person will see it when they
next look, not as an alert.
