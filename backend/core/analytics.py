"""
Analytics endpoints.

All figures are scoped by the caller's role via core.permissions.scope_queryset,
so a branch manager's dashboard shows their branch and a company admin's shows
the company. The previous earnings view aggregated with no company filter in
one branch and looped month-by-month issuing two queries per month; here each
series is a single grouped query.

CACHING. Every handler below is wrapped in `cached_scoped_response`, because
these are the most query-expensive reads in the API and a dashboard polls them
together on every page load. The cache key is derived from the CALLER, not
just the endpoint — read the module docstring in core/caching.py before
touching a prefix or adding a decorator, because a key that loses the scope
turns a cache into a cross-tenant data leak.
"""

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db.models import (
    Count, DecimalField, IntegerField, OuterRef, Q, Subquery, Sum, Value,
)
from django.db.models.functions import Coalesce, TruncMonth
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .caching import cached_scoped_response
from .models import (
    Branch, Commission, Enquiry, Enrollment, Payment, Registration,
    VisaTracking,
)

User = get_user_model()
from .permissions import IsAuthenticatedAndActive, IsManagerOrAbove, scope_queryset

MONEY = DecimalField(max_digits=14, decimal_places=2)


def _zero():
    return Value(0, output_field=MONEY)


class AnalyticsBase(APIView):
    """
    Open to any active user.

    Reserved for the two series an EMPLOYEE-facing screen actually renders;
    everything else belongs on `ManagerAnalytics` below.
    """

    permission_classes = [IsAuthenticatedAndActive]

    def scoped(self, model, entity_type=None):
        return scope_queryset(model.objects.all(), self.request.user, entity_type)


class ManagerAnalytics(AnalyticsBase):
    """
    Aggregates the UI only ever renders behind `CAN.viewAnalytics`
    (rbac/roles.ts:96 — admins, head managers and branch managers), i.e. the
    /app/analytics and /app/reports pages, both role-gated in proxy.ts:88-89.

    They were all `IsAuthenticatedAndActive`, so an employee could read the
    company funnel, the revenue series and the per-branch league table by
    calling the endpoint directly. The figures are scope-filtered, but the
    shape of the report is a management view the product does not offer them.
    """

    permission_classes = [IsManagerOrAbove]


class OverviewAnalytics(AnalyticsBase):
    """
    Headline counters plus month-over-month movement.

    DELIBERATELY open to employees, unlike the rest of this module: the
    employee dashboard renders these counters (dashboard/page.tsx:582, inside
    `EmployeeDashboard`). They are scope-filtered, so an employee's totals
    count only their own records.
    """

    # The heaviest endpoint in the API: eight aggregates across four
    # models, and the one every role's dashboard loads on sight.
    @cached_scoped_response('analytics:overview')
    def get(self, request):
        now = timezone.now()
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        prev_start = (month_start - timedelta(days=1)).replace(day=1)

        enquiries = self.scoped(Enquiry, 'enquiry')
        registrations = self.scoped(Registration, 'registration')
        enrollments = self.scoped(Enrollment, 'enrollment')
        payments = self.scoped(Payment, 'payment')

        this_month = payments.filter(
            status=Payment.Status.SUCCESS, date__gte=month_start,
        ).aggregate(total=Coalesce(Sum('amount'), _zero()))['total']
        last_month = payments.filter(
            status=Payment.Status.SUCCESS, date__gte=prev_start, date__lt=month_start,
        ).aggregate(total=Coalesce(Sum('amount'), _zero()))['total']

        growth = 0.0
        if last_month:
            growth = round(float((this_month - last_month) / last_month) * 100, 1)

        enquiry_counts = enquiries.aggregate(
            total=Count('id'),
            converted=Count('id', filter=Q(status=Enquiry.Status.CONVERTED)),
            new_this_month=Count('id', filter=Q(created_at__gte=month_start)),
            last_month=Count(
                'id', filter=Q(created_at__gte=prev_start, created_at__lt=month_start),
            ),
        )

        # Prior-period counts, so the dashboard's trend arrows reflect real
        # movement. Without these the UI either invents a number or shows a
        # hardcoded zero, and a fabricated trend is worse than none.
        registration_counts = registrations.aggregate(
            this_month=Count('id', filter=Q(created_at__gte=month_start)),
            last_month=Count(
                'id', filter=Q(created_at__gte=prev_start, created_at__lt=month_start),
            ),
        )
        enrollment_counts = enrollments.aggregate(
            this_month=Count('id', filter=Q(created_at__gte=month_start)),
            last_month=Count(
                'id', filter=Q(created_at__gte=prev_start, created_at__lt=month_start),
            ),
        )

        def pct_change(current, previous):
            if not previous:
                return 100.0 if current else 0.0
            return round((current - previous) / previous * 100, 1)

        return Response({
            'enquiries': enquiry_counts['total'],
            'enquiriesThisMonth': enquiry_counts['new_this_month'],
            'enquiriesLastMonth': enquiry_counts['last_month'],
            'enquiriesTrend': pct_change(
                enquiry_counts['new_this_month'], enquiry_counts['last_month'],
            ),
            'registrationsThisMonth': registration_counts['this_month'],
            'registrationsLastMonth': registration_counts['last_month'],
            'registrationsTrend': pct_change(
                registration_counts['this_month'], registration_counts['last_month'],
            ),
            'enrollmentsThisMonth': enrollment_counts['this_month'],
            'enrollmentsLastMonth': enrollment_counts['last_month'],
            'enrollmentsTrend': pct_change(
                enrollment_counts['this_month'], enrollment_counts['last_month'],
            ),
            'registrations': registrations.count(),
            'enrollments': enrollments.count(),
            'converted': enquiry_counts['converted'],
            'conversionRate': (
                round(enquiry_counts['converted'] / enquiry_counts['total'] * 100, 1)
                if enquiry_counts['total'] else 0.0
            ),
            'revenueThisMonth': this_month,
            'revenueLastMonth': last_month,
            'revenueGrowth': growth,
            'pendingPayments': payments.filter(
                status=Payment.Status.PENDING,
            ).aggregate(total=Coalesce(Sum('amount'), _zero()))['total'],
            'totalRevenue': payments.filter(
                status=Payment.Status.SUCCESS,
            ).aggregate(total=Coalesce(Sum('amount'), _zero()))['total'],
        })


class FunnelAnalytics(ManagerAnalytics):
    """Enquiry -> registration -> enrollment -> visa approved."""

    # Four COUNT(*) over four scoped tables.
    @cached_scoped_response('analytics:funnel')
    def get(self, request):
        enquiries = self.scoped(Enquiry, 'enquiry').count()
        registrations = self.scoped(Registration, 'registration').count()
        enrollments = self.scoped(Enrollment, 'enrollment').count()
        visas = self.scoped(VisaTracking, 'visa_tracking').filter(
            current_stage='Approved',
        ).count()

        def rate(n, d):
            return round(n / d * 100, 1) if d else 0.0

        return Response({
            'stages': [
                {'stage': 'Enquiries', 'count': enquiries, 'rate': 100.0},
                {'stage': 'Registrations', 'count': registrations,
                 'rate': rate(registrations, enquiries)},
                {'stage': 'Enrollments', 'count': enrollments,
                 'rate': rate(enrollments, enquiries)},
                {'stage': 'Visas approved', 'count': visas,
                 'rate': rate(visas, enquiries)},
            ],
            'dropOff': {
                'enquiryToRegistration': enquiries - registrations,
                'registrationToEnrollment': registrations - enrollments,
                'enrollmentToVisa': enrollments - visas,
            },
        })


class RevenueAnalytics(ManagerAnalytics):
    """
    Monthly revenue for the trailing 12 months.

    One grouped query, where the previous implementation ran two aggregate
    queries per month inside a Python loop.
    """

    # Two grouped scans over up to 36 months of payments and
    # commissions. `months` is a query parameter, and scoped_cache_key
    # folds the query string in, so ?months=1 and ?months=12 are
    # separate entries rather than one answering for the other.
    @cached_scoped_response('analytics:revenue')
    def get(self, request):
        raw = request.query_params.get('months', 12)
        try:
            months = int(raw)
        except (TypeError, ValueError):
            raise ValidationError({'error': 'months must be a number.'})
        # Bounded: an unvalidated value overflows timedelta and lets a client
        # ask for an arbitrarily expensive scan.
        months = max(1, min(months, 36))

        now = timezone.now()
        # Step back whole months rather than 31-day blocks, which reached 372
        # days for months=12 and produced a spurious 13th bucket.
        year, month = now.year, now.month - (months - 1)
        while month <= 0:
            month += 12
            year -= 1
        start = now.replace(
            year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0,
        )

        payments = self.scoped(Payment, 'payment').filter(
            status=Payment.Status.SUCCESS, date__gte=start,
        ).annotate(month=TruncMonth('date')).values('month').annotate(
            total=Coalesce(Sum('amount'), _zero()),
            count=Count('id'),
            registration=Coalesce(Sum('amount', filter=Q(type='Registration')), _zero()),
            enrollment=Coalesce(Sum('amount', filter=Q(type='Enrollment')), _zero()),
        ).order_by('month')

        commissions = self.scoped(Commission).filter(
            created_at__gte=start,
        ).annotate(month=TruncMonth('created_at')).values('month').annotate(
            total=Coalesce(Sum('commission_amount'), _zero()),
        ).order_by('month')
        commission_by_month = {c['month']: c['total'] for c in commissions}

        series = [
            {
                'month': row['month'].strftime('%Y-%m') if row['month'] else None,
                'label': row['month'].strftime('%b %Y') if row['month'] else '',
                'revenue': row['total'],
                'transactions': row['count'],
                'registrationFees': row['registration'],
                'enrollmentFees': row['enrollment'],
                'otherFees': row['total'] - row['registration'] - row['enrollment'],
                'commissions': commission_by_month.get(row['month'], 0),
            }
            for row in payments
        ]
        return Response({'series': series})


class BranchAnalytics(ManagerAnalytics):
    """Per-branch comparison, for admins and head managers."""

    # Five correlated subqueries PER BRANCH. Cost grows with the
    # tenant's branch count, which is exactly the tenant most likely to
    # be polling it.
    @cached_scoped_response('analytics:branches')
    def get(self, request):
        user = request.user
        branches = Branch.objects.filter(is_active=True)
        if not user.is_dev_admin:
            branches = branches.filter(company_id=user.company_id)
        if user.is_head_manager or user.is_branch_manager:
            from .permissions import branch_ids_for
            branches = branches.filter(id__in=branch_ids_for(user))

        # Each aggregate is its own correlated subquery.
        #
        # Annotating several multi-valued relations in ONE queryset makes the
        # joins multiply: the SQL emits a row per (enquiry x registration x
        # enrollment x user x payment) combination, so a Sum over that counts
        # each payment once per combination. `distinct=True` rescues the
        # Counts but cannot rescue the Sum — it would dedupe equal amounts,
        # which is a different wrong answer. Subqueries keep each aggregate on
        # its own row set.
        def count_of(model, **filters):
            return Subquery(
                model.objects.filter(branch=OuterRef('pk'), **filters)
                .order_by().values('branch')
                .annotate(n=Count('id')).values('n')[:1],
                output_field=IntegerField(),
            )

        branches = branches.annotate(
            enquiry_count=Coalesce(count_of(Enquiry), Value(0)),
            registration_count=Coalesce(count_of(Registration), Value(0)),
            enrollment_count=Coalesce(count_of(Enrollment), Value(0)),
            staff_count=Coalesce(count_of(User), Value(0)),
            revenue=Coalesce(
                Subquery(
                    Payment.objects.filter(
                        branch=OuterRef('pk'), status=Payment.Status.SUCCESS,
                    ).order_by().values('branch')
                    .annotate(total=Sum('amount')).values('total')[:1],
                    output_field=MONEY,
                ),
                _zero(),
            ),
        ).order_by('name')

        return Response([
            {
                'id': b.id,
                'name': b.name,
                'city': b.city,
                'staff': b.staff_count,
                'enquiries': b.enquiry_count,
                'registrations': b.registration_count,
                'enrollments': b.enrollment_count,
                'revenue': b.revenue,
                'conversionRate': (
                    round(b.registration_count / b.enquiry_count * 100, 1)
                    if b.enquiry_count else 0.0
                ),
            }
            for b in branches
        ])


class VisaPipelineAnalytics(AnalyticsBase):
    """
    Kept open to employees: /app/visa-tracking renders this counter strip
    (visa-tracking/page.tsx:71) and carries no role gate in proxy.ts or in the
    page itself. Scope-filtered like everything else here.
    """

    # One grouped query, but it sits on a page that reloads it often.
    @cached_scoped_response('analytics:visa-pipeline')
    def get(self, request):
        rows = self.scoped(VisaTracking, 'visa_tracking').values(
            'current_stage',
        ).annotate(count=Count('id')).order_by('current_stage')
        counts = {r['current_stage']: r['count'] for r in rows}
        stages = [s[0] for s in VisaTracking.STAGE_CHOICES]
        return Response({
            'pipeline': [{'stage': s, 'count': counts.get(s, 0)} for s in stages],
            'total': sum(counts.values()),
        })


class SourceAnalytics(ManagerAnalytics):
    """Where enquiries come from, and how well each source converts."""

    # One grouped query; cached for consistency with the rest of the
    # module rather than for its own cost.
    @cached_scoped_response('analytics:sources')
    def get(self, request):
        rows = self.scoped(Enquiry, 'enquiry').values('stream').annotate(
            total=Count('id'),
            converted=Count('id', filter=Q(status=Enquiry.Status.CONVERTED)),
        ).order_by('-total')
        return Response([
            {
                'source': r['stream'] or 'Unspecified',
                'total': r['total'],
                'converted': r['converted'],
                'conversionRate': round(r['converted'] / r['total'] * 100, 1) if r['total'] else 0.0,
            }
            for r in rows
        ])
