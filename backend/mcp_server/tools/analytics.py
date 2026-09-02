"""
The six analytics endpoints, plus the health probe.

Every figure these return is already narrowed by `core.permissions.scope_queryset`
on the server, so an employee's "total revenue" is their own and a branch
manager's funnel is their branch. Nothing is filtered here; the tools are thin
on purpose, because a second opinion about scope in this process would be a
second place for it to be wrong.

Two of the six (`overview`, `visa-pipeline`) are open to every role because the
employee dashboard renders them. The other four need `viewAnalytics`, which by
default starts at branch manager — an employee calling them gets a 403 from the
API, which reaches the caller as a tool error naming the capability to check.
"""

from __future__ import annotations

from typing import Any

import httpx
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

from ..server import ServerState, client_for, run_api

# Appended to every cached endpoint's description. The backend caches these
# per caller for SCOPED_CACHE_SECONDS (30 s by default), so an agent that
# writes a payment and immediately re-reads the dashboard can see the old
# number and conclude the write failed. Saying so is cheaper than the retry
# loop that follows from not saying so.
CACHE_NOTE = (' Cached server-side per caller for about 30 seconds (SCOPED_CACHE_SECONDS): a write you '
              'just made may not be reflected yet, so do not treat a stale counter as a failed write.')

MIN_MONTHS, MAX_MONTHS = 1, 36


def register_analytics_tools(mcp: FastMCP, state: ServerState) -> None:
    def add(fn, name: str, title: str, cached: bool = True) -> None:
        """
        Register one read-only tool, with the cache warning appended.

        The description is assembled here rather than left to the docstring so
        the shared warning is written in one place. Every tool in this module
        reads, so `readOnlyHint` is not a parameter — a write here would be a
        bug, not a configuration.
        """
        mcp.add_tool(fn, name=name, structured_output=True,
                     description=(fn.__doc__ or '').strip() + (CACHE_NOTE if cached else ''),
                     annotations=ToolAnnotations(title=title, readOnlyHint=True))

    def analytics_overview(ctx: Context) -> dict[str, Any]:
        """Dashboard counters for the caller's scope: enquiries, registrations, enrollments and revenue for this month against last, plus conversionRate, totalRevenue and pendingPayments. Open to every role — an employee sees only the records they own."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/overview/'))

    def analytics_funnel(ctx: Context) -> dict[str, Any]:
        """Admissions funnel {stages: [{stage, count, rate}] for Enquiries, Registrations, Enrollments and Visas approved, dropOff: {enquiryToRegistration, registrationToEnrollment, enrollmentToVisa}}. Needs the viewAnalytics capability (branch manager and above by default)."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/funnel/'))

    def analytics_revenue(ctx: Context, months: int = 12) -> dict[str, Any]:
        """Monthly revenue for the last `months` calendar months (1-36, default 12): {series: [{month, label, revenue, transactions, registrationFees, enrollmentFees, otherFees, commissions}]}. Only Success payments count, and a month with no payments has no row, so the series can be shorter than `months`. Needs viewAnalytics."""
        months = int(months)
        if not MIN_MONTHS <= months <= MAX_MONTHS:
            # Refused here rather than passed on, because the endpoint silently
            # clamps out-of-range values: months=0 would answer for 1 month and
            # months=999 for 36, and a caller cannot tell that from the reply.
            raise ToolError(f'months must be between {MIN_MONTHS} and {MAX_MONTHS}; got {months}.')
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/revenue/', params={'months': months}))

    def analytics_branches(ctx: Context) -> list[Any]:
        """Per-branch comparison, a bare array of {id, name, city, staff, enquiries, registrations, enrollments, revenue, conversionRate} ordered by name. A manager sees only the branches they cover. Needs viewAnalytics."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/branches/'))

    def analytics_visa_pipeline(ctx: Context) -> dict[str, Any]:
        """Visa stage counts {pipeline: [{stage, count}] for all seven stages in order (Documents, Applied, Biometrics, Interview, Decision, Approved, Rejected), total}. Open to every role."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/visa-pipeline/'))

    def analytics_sources(ctx: Context) -> list[Any]:
        """Where enquiries come from, a bare array of {source, total, converted, conversionRate} ordered by total descending. `source` is the enquiry's stream. Needs viewAnalytics."""
        client = client_for(ctx, state)
        return run_api(lambda: client.get('analytics/sources/'))

    def health(ctx: Context) -> dict[str, Any]:
        """Is the backend reachable and is its database answering? Returns {status: ok|degraded, http_status}. Unauthenticated, so it still answers when the configured credentials are wrong — call it first when another tool reports it could not reach the API."""
        # Sent straight on the transport, not through ApiClient: the endpoint is
        # AllowAny, and a liveness probe that needs working credentials cannot
        # distinguish "the backend is down" from "my API key was revoked". The
        # 503 it answers when the database is unreachable is this tool's result
        # rather than an error, which is the other reason to bypass ApiClient's
        # raise-on-5xx path.
        transport = state.transport
        try:
            response = transport.request('GET', 'health/')
        except (httpx.TransportError, OSError) as exc:
            target = getattr(transport, 'base_url', '') or 'the backend'
            raise ToolError(f'Could not reach {target}: {exc} — check CONSULTANCY_API_URL '
                            f'and that the backend is running.') from exc
        body = response.json()
        status = body.get('status') if isinstance(body, dict) else None
        return {'status': status or 'degraded', 'http_status': response.status}

    add(analytics_overview, 'analytics_overview', 'Analytics overview')
    add(analytics_funnel, 'analytics_funnel', 'Admissions funnel')
    add(analytics_revenue, 'analytics_revenue', 'Revenue series')
    add(analytics_branches, 'analytics_branches', 'Branch analytics')
    add(analytics_visa_pipeline, 'analytics_visa_pipeline', 'Visa pipeline')
    add(analytics_sources, 'analytics_sources', 'Enquiry sources')
    add(health, 'health', 'Backend health', cached=False)
