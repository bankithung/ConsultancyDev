# ConsultancyDev MCP tools

Generated from `mcp_server/catalog.json`. Do not edit by hand.

| Tool | Kind | API | Capability |
|---|---|---|---|
| `list_agents` | list | GET agents/ | manageCommissions |
| `get_agent` | read | GET agents/{id}/ | manageCommissions |
| `create_agent` | write | POST agents/ | manageCommissions |
| `update_agent` | write | PATCH agents/{id}/ | manageCommissions |
| `delete_agent` | destructive | DELETE agents/{id}/ | deleteRecords |
| `list_api_keys` | list | GET api-keys/ |  |
| `revoke_api_key` | action | POST api-keys/{id}/revoke/ | |
| `list_appointments` | list | GET appointments/ |  |
| `get_appointment` | read | GET appointments/{id}/ |  |
| `create_appointment` | write | POST appointments/ |  |
| `update_appointment` | write | PATCH appointments/{id}/ |  |
| `delete_appointment` | destructive | DELETE appointments/{id}/ | deleteRecords |
| `appointments_calendar` | action | GET appointments/calendar/ | |
| `list_approval_requests` | list | GET approval-requests/ |  |
| `get_approval_request` | read | GET approval-requests/{id}/ |  |
| `create_approval_request` | write | POST approval-requests/ |  |
| `update_approval_request` | write | PATCH approval-requests/{id}/ |  |
| `delete_approval_request` | destructive | DELETE approval-requests/{id}/ |  |
| `approve_approval_request` | action | POST approval-requests/{id}/approve/ | |
| `my_approval_requests` | action | GET approval-requests/my-requests/ | |
| `approval_pending_count` | action | GET approval-requests/pending-count/ | |
| `reject_approval_request` | action | POST approval-requests/{id}/reject/ | |
| `list_branches` | list | GET branches/ |  |
| `get_branch` | read | GET branches/{id}/ |  |
| `create_branch` | write | POST branches/ | manageBranches |
| `update_branch` | write | PATCH branches/{id}/ | manageBranches |
| `delete_branch` | destructive | DELETE branches/{id}/ | manageBranches |
| `list_commissions` | list | GET commissions/ | viewEarnings |
| `get_commission` | read | GET commissions/{id}/ | viewEarnings |
| `create_commission` | write | POST commissions/ | manageCommissions |
| `update_commission` | write | PATCH commissions/{id}/ | manageCommissions |
| `delete_commission` | destructive | DELETE commissions/{id}/ | deleteRecords |
| `list_companies` | list | GET companies/ | manageSettings |
| `get_company` | read | GET companies/{id}/ | manageSettings |
| `create_company` | write | POST companies/ | manageSettings |
| `update_company` | write | PATCH companies/{id}/ | manageSettings |
| `delete_company` | destructive | DELETE companies/{id}/ | manageSettings |
| `list_documents` | list | GET documents/ |  |
| `get_document` | read | GET documents/{id}/ |  |
| `create_document` | write | POST documents/ |  |
| `update_document` | write | PATCH documents/{id}/ |  |
| `delete_document` | destructive | DELETE documents/{id}/ | deleteRecords |
| `download_document` | action | GET documents/{id}/download/ | |
| `documents_expiring_soon` | action | GET documents/expiring-soon/ | |
| `list_enquiries` | list | GET enquiries/ |  |
| `get_enquiry` | read | GET enquiries/{id}/ |  |
| `create_enquiry` | write | POST enquiries/ |  |
| `update_enquiry` | write | PATCH enquiries/{id}/ |  |
| `delete_enquiry` | destructive | DELETE enquiries/{id}/ | deleteRecords |
| `list_enrollments` | list | GET enrollments/ |  |
| `get_enrollment` | read | GET enrollments/{id}/ |  |
| `create_enrollment` | write | POST enrollments/ |  |
| `update_enrollment` | write | PATCH enrollments/{id}/ |  |
| `delete_enrollment` | destructive | DELETE enrollments/{id}/ | deleteRecords |
| `list_follow_up_comments` | list | GET follow-up-comments/ |  |
| `get_follow_up_comment` | read | GET follow-up-comments/{id}/ |  |
| `create_follow_up_comment` | write | POST follow-up-comments/ |  |
| `update_follow_up_comment` | write | PATCH follow-up-comments/{id}/ |  |
| `delete_follow_up_comment` | destructive | DELETE follow-up-comments/{id}/ | deleteRecords |
| `list_follow_ups` | list | GET follow-ups/ |  |
| `get_follow_up` | read | GET follow-ups/{id}/ |  |
| `create_follow_up` | write | POST follow-ups/ |  |
| `update_follow_up` | write | PATCH follow-ups/{id}/ |  |
| `delete_follow_up` | destructive | DELETE follow-ups/{id}/ | deleteRecords |
| `list_installments` | list | GET installments/ |  |
| `get_installment` | read | GET installments/{id}/ |  |
| `update_installment` | write | PATCH installments/{id}/ |  |
| `delete_installment` | destructive | DELETE installments/{id}/ | deleteRecords |
| `list_notifications` | list | GET notifications/ |  |
| `get_notification` | read | GET notifications/{id}/ |  |
| `mark_all_notifications_read` | action | POST notifications/read-all/ | |
| `mark_notification_read` | action | POST notifications/{id}/read/ | |
| `unread_notification_count` | action | GET notifications/unread-count/ | |
| `list_payments` | list | GET payments/ |  |
| `get_payment` | read | GET payments/{id}/ |  |
| `create_payment` | write | POST payments/ |  |
| `update_payment` | write | PATCH payments/{id}/ |  |
| `delete_payment` | destructive | DELETE payments/{id}/ | deleteRecords |
| `payment_stats` | action | GET payments/stats/ | |
| `list_plans` | list | GET plans/ |  |
| `get_plan` | read | GET plans/{id}/ |  |
| `list_refunds` | list | GET refunds/ |  |
| `get_refund` | read | GET refunds/{id}/ |  |
| `create_refund` | write | POST refunds/ | manageRefunds |
| `update_refund` | write | PATCH refunds/{id}/ | manageRefunds |
| `delete_refund` | destructive | DELETE refunds/{id}/ | deleteRecords |
| `list_registrations` | list | GET registrations/ |  |
| `get_registration` | read | GET registrations/{id}/ |  |
| `create_registration` | write | POST registrations/ |  |
| `update_registration` | write | PATCH registrations/{id}/ |  |
| `delete_registration` | destructive | DELETE registrations/{id}/ | deleteRecords |
| `list_signup_requests` | list | GET signup-requests/ |  |
| `get_signup_request` | read | GET signup-requests/{id}/ |  |
| `create_signup_request` | write | POST signup-requests/ |  |
| `update_signup_request` | write | PATCH signup-requests/{id}/ |  |
| `delete_signup_request` | destructive | DELETE signup-requests/{id}/ |  |
| `approve_signup_request` | action | POST signup-requests/{id}/approve/ | |
| `reject_signup_request` | action | POST signup-requests/{id}/reject/ | |
| `list_student_documents` | list | GET student-documents/ |  |
| `get_student_document` | read | GET student-documents/{id}/ |  |
| `create_student_document` | write | POST student-documents/ |  |
| `update_student_document` | write | PATCH student-documents/{id}/ |  |
| `delete_student_document` | destructive | DELETE student-documents/{id}/ | deleteRecords |
| `return_student_documents` | action | POST student-documents/return-docs/ | |
| `list_student_remarks` | list | GET student-remarks/ |  |
| `get_student_remark` | read | GET student-remarks/{id}/ |  |
| `create_student_remark` | write | POST student-remarks/ |  |
| `update_student_remark` | write | PATCH student-remarks/{id}/ |  |
| `delete_student_remark` | destructive | DELETE student-remarks/{id}/ | deleteRecords |
| `list_subscriptions` | list | GET subscriptions/ |  |
| `get_subscription` | read | GET subscriptions/{id}/ |  |
| `get_my_subscription` | action | GET subscriptions/mine/ | |
| `list_tasks` | list | GET tasks/ |  |
| `get_task` | read | GET tasks/{id}/ |  |
| `create_task` | write | POST tasks/ |  |
| `update_task` | write | PATCH tasks/{id}/ |  |
| `delete_task` | destructive | DELETE tasks/{id}/ | deleteRecords |
| `reorder_tasks` | action | POST tasks/reorder/ | |
| `list_templates` | list | GET templates/ |  |
| `get_template` | read | GET templates/{id}/ |  |
| `create_template` | write | POST templates/ |  |
| `update_template` | write | PATCH templates/{id}/ |  |
| `delete_template` | destructive | DELETE templates/{id}/ | deleteRecords |
| `list_transfers` | list | GET transfers/ |  |
| `get_transfer` | read | GET transfers/{id}/ |  |
| `create_transfer` | write | POST transfers/ |  |
| `update_transfer` | write | PATCH transfers/{id}/ |  |
| `delete_transfer` | destructive | DELETE transfers/{id}/ |  |
| `accept_transfer` | action | POST transfers/{id}/accept/ | |
| `transfer_inbox` | action | GET transfers/inbox/ | |
| `transfer_outbox` | action | GET transfers/outbox/ | |
| `reject_transfer` | action | POST transfers/{id}/reject/ | |
| `list_universities` | list | GET universities/ |  |
| `get_university` | read | GET universities/{id}/ |  |
| `create_university` | write | POST universities/ |  |
| `update_university` | write | PATCH universities/{id}/ |  |
| `delete_university` | destructive | DELETE universities/{id}/ |  |
| `list_users` | list | GET users/ |  |
| `get_user` | read | GET users/{id}/ |  |
| `create_user` | write | POST users/ |  |
| `update_user` | write | PATCH users/{id}/ |  |
| `delete_user` | destructive | DELETE users/{id}/ |  |
| `change_password` | action | POST users/change-password/ | |
| `list_counselors` | action | GET users/counselors/ | |
| `get_me` | action | GET users/me/ | |
| `set_user_active` | action | POST users/{id}/set-active/ | |
| `list_visa_tracking` | list | GET visa-tracking/ |  |
| `get_visa_tracking` | read | GET visa-tracking/{id}/ |  |
| `create_visa_tracking` | write | POST visa-tracking/ |  |
| `update_visa_tracking` | write | PATCH visa-tracking/{id}/ |  |
| `delete_visa_tracking` | destructive | DELETE visa-tracking/{id}/ | deleteRecords |
| `analytics_overview` | analytics | GET | |
| `analytics_funnel` | analytics | GET | |
| `analytics_revenue` | analytics | GET | |
| `analytics_branches` | analytics | GET | |
| `analytics_visa_pipeline` | analytics | GET | |
| `analytics_sources` | analytics | GET | |
| `health` | analytics | GET | |
| `whoami` | composite | multiple | |
| `my_capabilities` | composite | multiple | |
| `explain_permission` | composite | multiple | |
| `upload_document` | composite | multiple | |
| `download_document` | composite | multiple | |
| `student_360` | composite | multiple | |
| `convert_enquiry_to_registration` | composite | multiple | |
| `enroll_student` | composite | multiple | |
| `record_payment` | composite | multiple | |
| `search_everything` | composite | multiple | |
| `daily_briefing` | composite | multiple | |
| `get_role_permissions` | composite | multiple | |
| `update_role_permissions` | composite | multiple | |
| `reset_role_permissions` | composite | multiple | |
