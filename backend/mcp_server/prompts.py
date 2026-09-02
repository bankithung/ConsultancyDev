"""
Guided workflows as MCP prompts.

Each returns a single user message: the client sends it as if the user had
typed it, and the model then drives the tools. They exist because the useful
sequences here are multi-step and easy to get subtly wrong — onboarding a
student touches five resources in a fixed order, and an installment schedule
built client-side will not add up. Encoding the order once, with the
confirm-before-write rule attached, is cheaper than hoping every client
rediscovers it.

Arguments are typed `str` even where they name an id or a count. MCP prompt
arguments are strings on the wire, and these values are interpolated into
prose rather than passed to an API, so parsing them here would only add a
failure mode.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.prompts.base import UserMessage


def register_prompts(mcp: FastMCP) -> None:
    @mcp.prompt(name='daily_briefing', description='Start-of-day summary for the signed-in user.')
    def daily_briefing(date: str = '') -> list[UserMessage]:
        when = f' for {date}' if date else ' for today'
        return [UserMessage(
            f'Call `whoami`, then `daily_briefing`{when}. Summarise: follow-ups due (group by enquiry, flag '
            'overdue), appointments today in time order, overdue installments with amounts, documents expiring '
            'within 30 days, pending approvals and transfers waiting on me, unread notifications. A section my '
            'role cannot read comes back as {"forbidden": true} — say so rather than reporting zero. '
            'End with the three most urgent actions, each naming the record and the tool that would act on it.'
        )]

    @mcp.prompt(name='onboard_student', description='Take an enquiry through registration, documents and enrollment.')
    def onboard_student(enquiry_id: str) -> list[UserMessage]:
        return [UserMessage(
            f'Onboard enquiry {enquiry_id}. Steps: 1) `get_enquiry` id={enquiry_id} and `student_360` '
            f'enquiry_id={enquiry_id}; confirm the candidate, contact details and preferred locations with me. '
            '2) Ask for the registration fee and payment status, then `convert_enquiry_to_registration` — the '
            'server assigns registration_no and books the registration-fee payment, so do not create either. '
            '3) List the documents on hand (`upload_document` for scans, `create_student_document` for physical '
            'originals). 4) When a program is chosen, `enroll_student` with installments_count so the server '
            'builds the schedule; never compute installment rows yourself. 5) Record any further payment with '
            '`record_payment`. Read consultancy://knowledge/pipeline first and confirm before each write.'
        )]

    @mcp.prompt(name='follow_up_digest', description='Review and plan follow-ups for the leads I own.')
    def follow_up_digest(days: str = '7') -> list[UserMessage]:
        return [UserMessage(
            f'Use `list_follow_ups` (ordering=scheduled_for, all_pages=true) and `list_enquiries` to build a '
            f'digest for the next {days} days: which leads are Interested or Thinking (outcome_status), which '
            'have High admission_possibility, which enquiries have NO follow-up scheduled. Propose the next '
            'action per lead. Only create follow-ups with `create_follow_up` after I approve, and when '
            'completing one, append to notes rather than overwriting them.'
        )]

    @mcp.prompt(name='pipeline_review', description='Weekly pipeline and revenue review for managers.')
    def pipeline_review(months: str = '3') -> list[UserMessage]:
        return [UserMessage(
            f'Run `analytics_overview`, `analytics_funnel`, `analytics_revenue` months={months}, '
            '`analytics_branches`, `analytics_visa_pipeline` and `analytics_sources`. Present: funnel drop-off '
            'with the weakest stage, revenue trend, branch comparison, visa stage distribution, top sources by '
            'conversion. Figures are cached about 30 seconds and scoped to my role, so say whose numbers these '
            'are — a branch manager\'s "company total" is their branch total. Revenue counts only Success payments.'
        )]

    @mcp.prompt(name='permissions_audit', description='Explain and review the role permission matrix.')
    def permissions_audit() -> list[UserMessage]:
        return [UserMessage(
            'Read consultancy://roles and call `get_role_permissions`. List every override (source=override) '
            'and whether it widens or narrows the default, flag any capability granted at or near its protected '
            'floor, and explain what each role can see (visibility). Use `explain_permission` for any cell I '
            'question, and `my_capabilities` for what my own role holds right now. Do not call '
            '`update_role_permissions` or `reset_role_permissions` unless I explicitly ask.'
        )]

    @mcp.prompt(name='troubleshoot_error', description='Explain an API/tool error and what to do next.')
    def troubleshoot_error(error: str) -> list[UserMessage]:
        return [UserMessage(
            f'A tool returned this error:\n\n{error}\n\nUsing consultancy://knowledge/api-conventions and '
            'consultancy://knowledge/gotchas, explain the cause and the fix. Common cases: 403 on a delete '
            'means raise `create_approval_request` with action="DELETE"; 403 otherwise is a missing capability, '
            'so check `my_capabilities` and `explain_permission`; 404 can mean the record is simply outside my '
            'visibility scope; 409 is any integrity error — usually a unique-value collision, so omit '
            'server-assigned references, but it can also mean a required relation was null (a dev admin '
            'creating a branch), which no amount of renaming will fix; 400 with fields means fix those fields '
            '(check consultancy://schema/<resource>); 429 means slow down; status 0 means the backend could '
            'not be reached at all.'
        )]
