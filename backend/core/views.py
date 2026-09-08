"""
API views.

Every tenant-owned resource inherits ScopedModelViewSet, which applies the
visibility rules from core.permissions in ONE place and stamps company/branch/
owner from the request user rather than trusting the payload.
"""

import io
import logging
import re

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Q, Sum
from django.http import FileResponse
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from . import capabilities, services
from .caching import cached_scoped_response
from .capabilities import role_has
from .filters import (
    AppointmentFilter, EnquiryFilter, EnrollmentFilter, FollowUpFilter,
    PaymentFilter, RefundFilter, RegistrationFilter,
)
from .models import (
    Agent, ApiKey, Appointment, ApprovalRequest, Branch, Capability, Commission,
    Company, Document,
    Enquiry, Enrollment, FollowUp, FollowUpComment, Installment,
    Notification,
    Payment, Plan, RecordTransfer, Refund, Registration, Role, RolePermission,
    SignupRequest,
    StudentDocument, StudentRemark, Subscription, Task, Template, University,
    VisaTracking,
)
from .permissions import (
    CanCreateStaff, CanManageAgents, CanManageCommissions,
    CanManageOwnCompany, CanManageRefunds,
    CanManageSettings, CanManageUsers,
    CanViewCounselors, IsAuthenticatedAndActive,
    IsDevAdmin, IsCompanyAdmin, ReadOnlyOrCompanyAdmin, ReadOnlyOrManager,
    ScopedObjectPermission, SubscriptionActive,
    branch_ids_for, can_write_object, scope_queryset,
)
from .serializers import (
    AgentSerializer, ApiKeyCreateSerializer, ApiKeySerializer,
    AppointmentSerializer, ApprovalRequestSerializer,
    BranchSerializer, ChangePasswordSerializer, CommissionSerializer,
    CompanyProfileSerializer, CompanySerializer, DocumentSerializer,
    EnquirySerializer,
    EnrollmentSerializer, FollowUpCommentSerializer, FollowUpSerializer,
    InstallmentSerializer,
    NotificationSerializer, PaymentSerializer,
    PlanSerializer, RecordTransferSerializer, RefundSerializer,
    RegistrationSerializer, RolePermissionUpdateSerializer,
    SignupRequestSerializer, StudentDocumentSerializer,
    StudentRemarkSerializer, SubscriptionSerializer, TaskSerializer,
    TemplateSerializer, UniversitySerializer, UserAdminSerializer,
    UserManagerCreateSerializer, UserSerializer, VisaTrackingSerializer,
)

logger = logging.getLogger('core')
security_log = logging.getLogger('core.security')
User = get_user_model()


def _camel_to_snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


# ===========================================================================
#  Base
# ===========================================================================

class ScopedModelViewSet(viewsets.ModelViewSet):
    """
    Tenant-scoped CRUD.

    - `get_queryset` narrows to what the caller may see (core.permissions).
    - `perform_create` stamps company/branch/created_by/owner server-side.
    - Those fields are read-only in the serializers, so a PATCH can no longer
      re-parent a record into another tenant.
    """

    permission_classes = [ScopedObjectPermission, SubscriptionActive]
    entity_type = None
    select_related_fields = ('company', 'branch', 'created_by', 'owner')
    prefetch_related_fields = ()

    def get_queryset(self):
        qs = super().get_queryset()
        if self.select_related_fields:
            qs = qs.select_related(*self.select_related_fields)
        if self.prefetch_related_fields:
            qs = qs.prefetch_related(*self.prefetch_related_fields)
        return scope_queryset(qs, self.request.user, self.entity_type)

    def _target_branch_id(self):
        user = self.request.user
        if user.branch_id:
            return user.branch_id
        if user.company_id:
            default = services.default_branch_for(user.company)
            return default.id if default else None
        return None

    def perform_create(self, serializer):
        user = self.request.user
        if not user.company_id and not user.is_dev_admin:
            raise ValidationError({'error': 'Your account is not linked to a company.'})
        serializer.save(
            company_id=user.company_id,
            branch_id=self._target_branch_id(),
            created_by=user,
            owner=user,
        )

    def perform_destroy(self, instance):
        """
        Deleting directly needs the `deleteRecords` capability; everyone else
        raises an approval request.

        Previously `update()` was overridden to block employees but
        `destroy()` was not, so switching the HTTP verb bypassed the entire
        approval workflow. The rule now comes from the company's permission
        matrix, whose default still denies employees — and whose floor keeps it
        that way, since granting `deleteRecords` to employees would not widen
        access so much as switch the approval trail off.
        """
        user = self.request.user
        if not role_has(user, Capability.DELETE_RECORDS):
            raise PermissionDenied(
                'Your role cannot delete records directly. Raise an approval '
                'request instead.'
            )
        if not can_write_object(user, instance, self.entity_type):
            raise PermissionDenied('You cannot modify this record.')
        instance.delete()


# ===========================================================================
#  Auth
# ===========================================================================

class RoleTokenObtainPairSerializer(TokenObtainPairSerializer):
    """
    Embed the identity claims the Next.js edge middleware needs.

    Without these the token carries only `user_id`, and the middleware has no
    way to resolve a role without a network round-trip per navigation â€” so it
    fails closed and every role-gated route redirects everyone, including
    admins.

    `get_token` returns the REFRESH token; SimpleJWT copies all claims except
    `no_copy_claims` (token_type, exp, jti, iat) onto the derived access token,
    so this covers rotation-on-refresh too and TokenRefreshView needs no change.

    These claims are for routing and UI only. Every authorization decision is
    still made server-side against the database â€” a token is a client-held
    assertion, and stale claims (a role changed mid-session) must never be
    load-bearing.
    """

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token['role'] = user.role
        token['company'] = user.company_id
        token['branch'] = user.branch_id
        return token


class LoginView(TokenObtainPairView):
    permission_classes = [AllowAny]
    serializer_class = RoleTokenObtainPairSerializer
    throttle_scope = 'login'

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        if response.status_code == 200:
            user = User.objects.select_related('company', 'branch').filter(
                username=request.data.get('username'),
            ).first()
            if user and not user.is_active_employee:
                security_log.info('Blocked login for deactivated user %s', user.username)
                return Response(
                    {'error': 'Your account has been deactivated.'},
                    status=status.HTTP_403_FORBIDDEN,
                )
            if user:
                response.data['user'] = UserSerializer(user).data
                security_log.info('Login success for %s (%s)', user.username, user.role)
        else:
            security_log.info('Login failure for username=%r', request.data.get('username'))
        return response


class LogoutView(APIView):
    """
    Real logout. The previous implementation only cleared localStorage on the
    client, so a stolen token stayed valid for its full lifetime.
    """

    permission_classes = [IsAuthenticatedAndActive]

    def post(self, request):
        refresh = request.data.get('refresh')
        if not refresh:
            return Response({'error': 'A refresh token is required.'}, status=400)
        try:
            RefreshToken(refresh).blacklist()
        except Exception:
            # An already-blacklisted or malformed token is still a logout.
            pass
        security_log.info('Logout for %s', request.user.username)
        return Response(status=status.HTTP_205_RESET_CONTENT)


# ===========================================================================
#  Users, companies, branches
# ===========================================================================

class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.select_related('company', 'branch').prefetch_related(
        'managed_managers',
    ).all()
    serializer_class = UserSerializer
    # `is_dev_admin` and friends are properties, not fields â€” filter on `role`.
    filterset_fields = ('role', 'branch', 'is_active_employee')
    search_fields = ('username', 'first_name', 'last_name', 'email')
    ordering_fields = ('username', 'role', 'last_login')

    def get_serializer_class(self):
        """
        The serializer is chosen by WHO is asking, never by which action.

        An earlier version returned UserAdminSerializer for create/update/
        partial_update before testing the caller, which handed every
        authenticated user a serializer where `role`, `branch` and `password`
        are writable. An employee could PATCH their own row to COMPANY_ADMIN,
        reassign themselves to another branch, or change their password
        without supplying the current one.

        The manager branch below tests `self.action` as well, and that is not a
        relapse. The defect above was a permissive serializer reaching a
        caller's OWN row; `create` has no row to reach, and
        `UserManagerCreateSerializer` cannot express anything but an employee —
        `perform_create` then pins the role and the branch. Managers keep the
        read-only `UserSerializer` for every update, their own included, so
        there is still no path by which anyone edits their own role or branch.
        """
        user = self.request.user
        if not user.is_authenticated:
            return UserSerializer
        if user.can_manage_users:
            return UserAdminSerializer
        if self.action == 'create' and user.role in (Role.HEAD_MANAGER, Role.BRANCH_MANAGER):
            return UserManagerCreateSerializer
        return UserSerializer

    def get_permissions(self):
        # `create` is deliberately wider than the other two: managers may hire
        # employees into their own branches (see perform_create), but deleting
        # or deactivating an account stays with `manageUsers`.
        if self.action == 'create':
            return [CanCreateStaff()]
        if self.action in ('destroy', 'set_active'):
            return [CanManageUsers()]
        if self.action == 'counselors':
            return [CanViewCounselors()]
        return [IsAuthenticatedAndActive()]

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()

        # Only admins receive UserAdminSerializer, which serialises the
        # `managed_managers` M2M â€” one query per row without a prefetch, so a
        # full 200-row page costs 201 queries. Prefetching is conditional
        # because everyone else gets UserSerializer, which has no such field,
        # and an unconditional prefetch would add a query to the common path.
        if user.is_authenticated and user.can_manage_users:
            qs = qs.prefetch_related('managed_managers')

        if user.is_dev_admin:
            return qs
        if not user.company_id:
            return qs.filter(pk=user.pk)
        qs = qs.filter(company_id=user.company_id)
        if user.is_company_admin:
            return qs
        if user.is_head_manager:
            # The head manager sees the full company team, including unassigned staff.
            return qs
        if user.is_branch_manager:
            return qs.filter(Q(branch_id=user.branch_id) | Q(pk=user.pk))
        return qs.filter(pk=user.pk)

    def _check_manager_may_hire(self, validated_data):
        """
        The two limits on a manager's hiring right, enforced server-side.

        A head or branch manager reaches `create` through `CanCreateStaff`,
        which is only the outer door. Both checks below are the actual rule, and
        both are authorization decisions rather than validation ones — hence
        403 and not 400:

          1. EMPLOYEE only. Without this a branch manager could create a
             COMPANY_ADMIN and own the tenant, which is exactly the escalation
             `manageUsers` is floored to prevent.
          2. Their managed branches only. A branch manager is limited to their
             own branch; a head manager can staff any branch in their company.
        """
        actor = self.request.user
        role = validated_data.get('role', Role.EMPLOYEE)
        if role != Role.EMPLOYEE:
            raise PermissionDenied(
                'Managers can only create employee accounts. Ask a company '
                'admin to add a manager or an admin.'
            )

        branch = validated_data.get('branch')
        allowed = branch_ids_for(actor)
        if branch is None or branch.pk not in allowed:
            raise PermissionDenied(
                'You can only add staff to a branch you manage.'
            )

    def perform_create(self, serializer):
        actor = self.request.user
        company = actor.company
        if not actor.can_manage_users:
            # Reached only by a head or branch manager: `CanCreateStaff` has
            # already turned everyone else away.
            self._check_manager_may_hire(serializer.validated_data)
        if company:
            try:
                services.check_user_quota(company)
            except DjangoValidationError as exc:
                raise ValidationError({'error': exc.messages[0]})
        created = serializer.save(company=company)
        security_log.info(
            'User %s (%s) created by %s (%s)',
            created.username, created.role, actor.username, actor.role,
        )

    def perform_update(self, serializer):
        actor = self.request.user
        if not actor.can_manage_users and serializer.instance.pk != actor.pk:
            raise PermissionDenied('You can only edit your own profile.')
        serializer.save()

    @action(detail=False, methods=['get'])
    def me(self, request):
        return Response(UserSerializer(request.user).data)

    @action(detail=False, methods=['post'], url_path='change-password')
    def change_password(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data['new_password'])
        request.user.save(update_fields=['password'])
        security_log.info('Password changed for %s', request.user.username)
        return Response({'status': 'Password updated.'})

    @action(detail=True, methods=['post'], url_path='set-active')
    def set_active(self, request, pk=None):
        target = self.get_object()
        if target.pk == request.user.pk:
            raise ValidationError({'error': 'You cannot deactivate your own account.'})
        target.is_active_employee = bool(request.data.get('is_active', True))
        target.save(update_fields=['is_active_employee'])
        if not target.is_active_employee:
            # Deactivation must end live sessions, not just block the next login.
            services.revoke_all_tokens(target)
        security_log.info(
            'User %s set is_active_employee=%s by %s',
            target.username, target.is_active_employee, request.user.username,
        )
        return Response(UserSerializer(target).data)

    @action(detail=False, methods=['get'])
    def counselors(self, request):
        """
        Per-counselor performance.

        The previous version computed its metrics outside the per-counselor
        loop, so every counselor showed the same global figure, and it queried
        every EMPLOYEE on the platform regardless of company.
        """
        users = self.get_queryset().filter(
            role__in=[Role.EMPLOYEE, Role.BRANCH_MANAGER], is_active=True,
        ).annotate(
            total_enquiries=Count('created_enquirys', distinct=True),
            converted=Count(
                'created_enquirys',
                filter=Q(created_enquirys__status=Enquiry.Status.CONVERTED),
                distinct=True,
            ),
            registration_count=Count('created_registrations', distinct=True),
            enrollment_count=Count('created_enrollments', distinct=True),
        )
        return Response([
            {
                'id': u.id,
                'name': u.get_full_name() or u.username,
                'email': u.email,
                'avatar': u.avatar,
                'branch': u.branch.name if u.branch else None,
                'totalEnquiries': u.total_enquiries or 0,
                'converted': u.converted or 0,
                'registrations': u.registration_count or 0,
                'enrollments': u.enrollment_count or 0,
                'conversionRate': (
                    round((u.converted or 0) / u.total_enquiries * 100, 1)
                    if u.total_enquiries else 0.0
                ),
            }
            for u in users
        ])


class CompanyViewSet(viewsets.ModelViewSet):
    queryset = Company.objects.select_related('subscription', 'subscription__plan').annotate(
        branch_count=Count('branches', distinct=True),
        user_count=Count('users', distinct=True),
    )
    serializer_class = CompanySerializer
    permission_classes = [CanManageOwnCompany]
    search_fields = ('name', 'email')

    def get_queryset(self):
        """
        A non-dev-admin sees exactly one company: their own.

        Scoping here rather than leaning on the object permission alone is what
        turns `/api/companies/<someone else's id>/` into a 404 instead of a 403
        — the same reasoning as `ScopedObjectPermission`'s docstring, applied
        one level up. It also makes the list endpoint honest: `getCurrent()` on
        the Settings page reads `companies/?page_size=1` and takes the first
        row (apiClient.ts:1712), which is only correct if the caller's own row
        is the only one there.
        """
        qs = super().get_queryset()
        user = self.request.user
        if user.is_dev_admin:
            return qs
        if not user.company_id:
            return qs.none()
        return qs.filter(pk=user.company_id)

    def get_serializer_class(self):
        """
        Chosen by WHO is asking, never by which action — see
        CompanyProfileSerializer, and section 2 item 2 of the build spec.
        """
        user = self.request.user
        if user.is_authenticated and user.is_dev_admin:
            return CompanySerializer
        return CompanyProfileSerializer

    def perform_create(self, serializer):
        company, _ = services.provision_company(
            name=serializer.validated_data['name'],
            email=serializer.validated_data.get('email', ''),
            phone=serializer.validated_data.get('phone', ''),
            address=serializer.validated_data.get('address', ''),
        )
        serializer.instance = company


class BranchViewSet(viewsets.ModelViewSet):
    queryset = Branch.objects.select_related('company').annotate(
        user_count=Count('users', distinct=True),
    )
    serializer_class = BranchSerializer
    # `manageBranches` is admin-only (rbac/roles.ts:94). `perform_create` below
    # already refused a non-admin POST, but ReadOnlyOrManager left PATCH and
    # DELETE open to head and branch managers, who could rename a branch or
    # delete an empty one. Reads stay open: the admissions filter drawer and
    # the transfer modal both need the branch list.
    permission_classes = [ReadOnlyOrCompanyAdmin, SubscriptionActive]
    search_fields = ('name', 'code', 'city')

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        if user.is_dev_admin:
            return qs
        if not user.company_id:
            return qs.none()
        qs = qs.filter(company_id=user.company_id)
        if user.is_company_admin:
            return qs
        branches = branch_ids_for(user)
        return qs.filter(id__in=branches) if branches else qs.none()

    def perform_create(self, serializer):
        user = self.request.user
        if not role_has(user, Capability.MANAGE_BRANCHES):
            raise PermissionDenied('Only a company admin can create branches.')
        try:
            services.check_branch_quota(user.company)
        except DjangoValidationError as exc:
            raise ValidationError({'error': exc.messages[0]})
        serializer.save(company=user.company)

    @action(detail=True, methods=['post'], url_path='set-default')
    def set_default(self, request, pk=None):
        branch = self.get_object()
        with transaction.atomic():
            Company.objects.select_for_update().get(pk=branch.company_id)
            branch.refresh_from_db()
            if not branch.is_active:
                raise ValidationError({'error': 'Activate this branch before making it the default.'})
            Branch.objects.filter(company_id=branch.company_id, is_default=True).exclude(pk=branch.pk).update(is_default=False)
            branch.is_default = True
            branch.save(update_fields=['is_default'])
        return Response(self.get_serializer(branch).data)

    def perform_destroy(self, instance):
        if instance.is_default:
            raise ValidationError({'error': 'The default branch cannot be deleted.'})
        if instance.users.exists():
            raise ValidationError(
                {'error': 'Reassign the staff in this branch before deleting it.'}
            )
        instance.delete()


class PlanViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Plan.objects.filter(is_active=True)
    serializer_class = PlanSerializer
    permission_classes = [AllowAny]
    pagination_class = None


class SubscriptionViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Subscription.objects.select_related('company', 'plan')
    serializer_class = SubscriptionSerializer
    # The DRF default is bare `IsAuthenticated`, which does not consult
    # `is_active_employee`; every other viewset here checks it.
    permission_classes = [IsAuthenticatedAndActive]

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        return qs if user.is_dev_admin else qs.filter(company_id=user.company_id)

    @action(detail=False, methods=['get'])
    def mine(self, request):
        sub = getattr(request.user.company, 'subscription', None) if request.user.company_id else None
        if not sub:
            return Response({'error': 'No subscription on file.'}, status=404)
        return Response(SubscriptionSerializer(sub).data)


# ===========================================================================
#  CRM resources
# ===========================================================================

class EnquiryViewSet(ScopedModelViewSet):
    queryset = Enquiry.objects.all()
    serializer_class = EnquirySerializer
    entity_type = 'enquiry'
    # A FilterSet rather than `filterset_fields`: the directory's filters are
    # multi-select, and a generated exact-match filter can only ever express
    # `status = New`. See core/filters.py for the wire format.
    filterset_class = EnquiryFilter
    search_fields = ('candidate_name', 'school_name', 'mobile', 'email', 'course_interested')
    ordering_fields = ('created_at', 'status', 'school_name')


class RegistrationViewSet(ScopedModelViewSet):
    queryset = Registration.objects.all()
    serializer_class = RegistrationSerializer
    entity_type = 'registration'
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'enquiry')
    filterset_class = RegistrationFilter
    search_fields = ('student_name', 'registration_no', 'mobile', 'email')
    ordering_fields = ('created_at', 'student_name', 'registration_fee')

    @transaction.atomic
    def perform_create(self, serializer):
        # Assign the reference server-side when the client does not supply one.
        # It is required and uniquely constrained per company, but nothing
        # generated it, so every create that omitted it returned 400.
        if not serializer.validated_data.get('registration_no'):
            serializer.validated_data['registration_no'] = services.next_reference_number(
                Registration, self.request.user.company_id, 'registration_no', 'REG',
            )
        super().perform_create(serializer)
        registration = serializer.instance
        # Book the fee with the status the user actually chose, instead of
        # unconditionally recording a successful cash payment.
        Payment.objects.create(
            company_id=registration.company_id,
            branch_id=registration.branch_id,
            created_by=registration.created_by,
            owner=registration.owner,
            registration=registration,
            student_name=registration.student_name,
            amount=registration.registration_fee,
            type='Registration',
            status=(
                Payment.Status.SUCCESS
                if (registration.payment_status or '').lower() == 'paid'
                else Payment.Status.PENDING
            ),
            method=registration.payment_method or 'Cash',
        )


class EnrollmentViewSet(ScopedModelViewSet):
    queryset = Enrollment.objects.all()
    serializer_class = EnrollmentSerializer
    entity_type = 'enrollment'
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'student', 'university')
    prefetch_related_fields = ('installments',)
    # `owner` matters as much here as on enquiries and registrations: without
    # it a "my students" view cannot ask the server for its own enrollments,
    # and filtering a single page on the client would silently hide everything
    # past the page boundary.
    filterset_class = EnrollmentFilter
    search_fields = ('enrollment_no', 'program_name', 'student__student_name')
    ordering_fields = ('created_at', 'total_fees', 'start_date')

    @transaction.atomic
    def perform_create(self, serializer):
        count = serializer.validated_data.pop('installments_count', 0)
        amount = serializer.validated_data.pop('installment_amount', None)
        if not serializer.validated_data.get('enrollment_no'):
            serializer.validated_data['enrollment_no'] = services.next_reference_number(
                Enrollment, self.request.user.company_id, 'enrollment_no', 'ENR',
            )
        super().perform_create(serializer)
        if count:
            services.build_installments(serializer.instance, count, amount)


class InstallmentViewSet(ScopedModelViewSet):
    queryset = Installment.objects.all()
    serializer_class = InstallmentSerializer
    select_related_fields = ('company', 'branch', 'enrollment')
    ordering_fields = ('due_date', 'number')


class PaymentViewSet(ScopedModelViewSet):
    queryset = Payment.objects.all()
    serializer_class = PaymentSerializer
    entity_type = 'payment'
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'registration')
    # Was `filterset_fields`, which is single-value only. See PaymentFilter.
    filterset_class = PaymentFilter
    search_fields = ('student_name', 'reference', 'type')
    ordering_fields = ('date', 'amount', 'status')

    @action(detail=False, methods=['get'])
    @cached_scoped_response('payments:stats')
    def stats(self, request):
        """
        Scoped payment totals.

        Previously this aggregated Payment.objects with no company filter and
        no authentication, so every tenant's dashboard showed platform-wide
        revenue.

        Cached per caller for SCOPED_CACHE_SECONDS. The key comes from
        core.caching.scoped_cache_key, which folds in the caller's identity —
        this endpoint's whole history is a tenant-isolation bug, and a cache
        keyed on the URL alone would reintroduce exactly it.

        `@action` is deliberately the OUTER decorator, so the `url_path` and
        `mapping` attributes the router reads are set on the object the router
        actually receives. The reverse order happens to survive — functools.wraps
        copies `__dict__` forward — but only by accident, and it puts the
        routing metadata one indirection away from the thing being routed.
        """
        qs = self.get_queryset()
        month_start = timezone.now().replace(
            day=1, hour=0, minute=0, second=0, microsecond=0,
        )
        totals = qs.aggregate(
            total=Sum('amount', filter=Q(status=Payment.Status.SUCCESS)),
            this_month=Sum(
                'amount', filter=Q(status=Payment.Status.SUCCESS, date__gte=month_start),
            ),
            pending=Sum('amount', filter=Q(status=Payment.Status.PENDING)),
        )
        return Response({
            'totalRevenue': totals['total'] or 0,
            'thisMonthRevenue': totals['this_month'] or 0,
            'pendingAmount': totals['pending'] or 0,
            'transactionCount': qs.count(),
        })


class DocumentViewSet(ScopedModelViewSet):
    queryset = Document.objects.all()
    serializer_class = DocumentSerializer
    entity_type = 'document'
    parser_classes = (MultiPartParser, FormParser, JSONParser)
    # `registration` and `enquiry` make membership a server-side question.
    # Without them a student's document list had to pull every page and
    # match on the displayed name, which is not an identity.
    filterset_fields = ('status', 'branch', 'type', 'registration', 'enquiry')
    search_fields = ('file_name', 'student_name', 'type')
    ordering_fields = ('uploaded_at', 'expiry_date')

    @transaction.atomic
    def perform_create(self, serializer):
        uploaded = serializer.validated_data.pop('file', None)
        super().perform_create(serializer)
        if uploaded:
            self._store(serializer.instance, uploaded)
            serializer.instance.save()

    @transaction.atomic
    def perform_update(self, serializer):
        """
        Replacing a file must go through the same pipeline as uploading one.

        Without this override a PATCH fell through to ModelSerializer.update(),
        which assigns the FileField directly to Django's DEFAULT storage. That
        wrote plaintext into the web-served MEDIA_ROOT, skipped the extension
        and size checks, left `is_encrypted` asserting True over unencrypted
        bytes, orphaned the previous blob, and left checksum/size describing
        the old file. The record then 404s on download forever, because
        read_document tries to decrypt plaintext.
        """
        uploaded = serializer.validated_data.pop('file', None)
        previous = serializer.instance.file.name if serializer.instance.file else None
        serializer.save()
        if uploaded:
            self._store(serializer.instance, uploaded)
            serializer.instance.save()
            if previous and previous != serializer.instance.file.name:
                services.delete_document_file_by_name(previous)

    @staticmethod
    def _store(instance, uploaded):
        try:
            services.store_document(instance, uploaded)
        except DjangoValidationError as exc:
            raise ValidationError({'file': exc.messages})

    def perform_destroy(self, instance):
        services.delete_document_file(instance)
        super().perform_destroy(instance)

    @action(detail=True, methods=['get'])
    def download(self, request, pk=None):
        """Stream the decrypted file. Scope is re-checked by get_object()."""
        document = self.get_object()
        data = services.read_document(document)
        if data is None:
            return Response({'error': 'File is not available.'}, status=404)
        security_log.info('Document %s downloaded by %s', document.pk, request.user.username)
        response = FileResponse(
            io.BytesIO(data),
            as_attachment=True,
            filename=document.file_name,
            content_type=document.content_type or 'application/octet-stream',
        )
        response['Cache-Control'] = 'private, no-store'
        return response

    @action(detail=False, methods=['get'], url_path='expiring-soon')
    def expiring_soon(self, request):
        try:
            days = int(request.query_params.get('days', 30))
        except (TypeError, ValueError):
            raise ValidationError({'error': 'days must be a number.'})
        cutoff = timezone.now().date() + timezone.timedelta(days=days)
        qs = self.get_queryset().filter(
            expiry_date__isnull=False, expiry_date__lte=cutoff,
        ).order_by('expiry_date')
        page = self.paginate_queryset(qs)
        if page is not None:
            return self.get_paginated_response(self.get_serializer(page, many=True).data)
        return Response(self.get_serializer(qs, many=True).data)


class TaskViewSet(ScopedModelViewSet):
    queryset = Task.objects.all()
    serializer_class = TaskSerializer
    entity_type = 'task'
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'assigned_to')
    filterset_fields = ('status', 'assigned_to', 'priority', 'branch')
    search_fields = ('title', 'description')
    ordering_fields = ('due_date', 'priority', 'status', 'position')

    @action(detail=False, methods=['post'])
    @transaction.atomic
    def reorder(self, request):
        """
        Persist a kanban board's card order.

        Without this the board can reorder on screen but has nowhere to save
        the result, so it resets on reload. Accepts
        `{"status": "In Progress", "ids": [3, 7, 1]}` and writes `position` in
        the order given. Ids outside the caller's scope are ignored rather than
        rejected, so a stale board cannot fail the whole request — the response
        reports how many actually moved.
        """
        ids = request.data.get('ids') or []
        new_status = request.data.get('status')
        if not isinstance(ids, list) or not ids:
            raise ValidationError({'ids': 'Provide an ordered list of task ids.'})

        scoped = {t.pk: t for t in self.get_queryset().filter(pk__in=ids)}
        updated = []
        for index, raw_id in enumerate(ids):
            task = scoped.get(raw_id)
            if task is None:
                continue
            task.position = index
            if new_status and task.status != new_status:
                task.status = new_status
                if new_status == 'Done' and not task.completed_at:
                    task.completed_at = timezone.now()
            updated.append(task)

        if updated:
            Task.objects.bulk_update(updated, ['position', 'status', 'completed_at'])
        return Response({'reordered': len(updated), 'requested': len(ids)})


class AppointmentViewSet(ScopedModelViewSet):
    queryset = Appointment.objects.all()
    serializer_class = AppointmentSerializer
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'counselor')
    filterset_class = AppointmentFilter
    search_fields = ('student_name', 'student_email')
    ordering_fields = ('date', 'status')

    @action(detail=False, methods=['get'])
    def calendar(self, request):
        # `filter_queryset`, not the bare queryset: a custom action does NOT run
        # the filter backends unless it asks, and the calendar shares its search
        # box and filter drawer with the list beside it. Without this the grid
        # answered every request with the whole month while the list narrowed,
        # and the only honest workaround was to re-apply both in the browser.
        qs = self.filter_queryset(self.get_queryset())
        month, year = request.query_params.get('month'), request.query_params.get('year')
        # Validate rather than letting a bad value raise a 500 mid-query.
        try:
            if year:
                qs = qs.filter(date__year=int(year))
            if month:
                qs = qs.filter(date__month=int(month))
        except (TypeError, ValueError):
            raise ValidationError({'error': 'month and year must be numbers.'})
        return Response(self.get_serializer(qs, many=True).data)


class UniversityViewSet(viewsets.ModelViewSet):
    queryset = University.objects.all()
    serializer_class = UniversitySerializer
    permission_classes = [ReadOnlyOrManager, SubscriptionActive]
    search_fields = ('name', 'country', 'city')
    ordering_fields = ('name', 'ranking', 'rating')

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        if user.is_dev_admin:
            return qs
        return qs.filter(Q(company_id=user.company_id) | Q(company__isnull=True))

    def perform_create(self, serializer):
        serializer.save(company=self.request.user.company)


class TemplateViewSet(ScopedModelViewSet):
    queryset = Template.objects.all()
    serializer_class = TemplateSerializer
    search_fields = ('name', 'subject', 'content')


class NotificationViewSet(viewsets.ReadOnlyModelViewSet):
    """Read and mark-as-read only. Creation is server-side (core.signals)."""

    queryset = Notification.objects.all()
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticatedAndActive]

    def get_queryset(self):
        return super().get_queryset().filter(user=self.request.user)

    @action(detail=True, methods=['post'], url_path='read')
    def mark_read(self, request, pk=None):
        notification = self.get_object()
        notification.is_read = True
        notification.save(update_fields=['is_read'])
        return Response(self.get_serializer(notification).data)

    @action(detail=False, methods=['post'], url_path='read-all')
    def mark_all_read(self, request):
        return Response({'updated': self.get_queryset().filter(is_read=False).update(is_read=True)})

    @action(detail=False, methods=['get'], url_path='unread-count')
    def unread_count(self, request):
        return Response({'count': self.get_queryset().filter(is_read=False).count()})


class AgentViewSet(ScopedModelViewSet):
    """
    Referral agents — the counterparty on every commission row.

    Admin-only, read included: the ONLY screen that touches `agents/` is
    /app/commissions (commissions/page.tsx:41,68), which proxy.ts:85 restricts
    to DEV_ADMIN and COMPANY_ADMIN. Inheriting the scope-only permissions let
    an employee list the company's referral partners and their commission
    rates, and create new ones.
    """

    queryset = Agent.objects.all()
    serializer_class = AgentSerializer
    permission_classes = [ScopedObjectPermission, CanManageAgents, SubscriptionActive]
    search_fields = ('name', 'email')


class CommissionViewSet(ScopedModelViewSet):
    queryset = Commission.objects.all()
    serializer_class = CommissionSerializer
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'agent', 'student')
    # Read stays at CanViewFinancials (admins + head managers); writing is
    # admin-only, matching CAN.manageCommissions. See CanManageCommissions.
    permission_classes = [ScopedObjectPermission, CanManageCommissions, SubscriptionActive]
    ordering_fields = ('created_at', 'commission_amount', 'status')


class RefundViewSet(ScopedModelViewSet):
    """
    Refunds: read within your own scope, write only as a manager.

    `manageRefunds` (rbac/roles.ts:103) is a manager capability and this
    viewset declared no permission class at all, so an employee could file,
    approve and process a refund — moving money — through the API while the UI
    hid every control.

    WRITE is gated to managers and above. READ is deliberately left to the
    scoped queryset, which already narrows an employee to `owner=self`: the
    student profile renders its "Refund history" card for every role
    unconditionally (StudentProfileView.tsx:784 -> RefundHistory.tsx:45, no
    capability check), so a blanket denial would replace a legitimately empty
    list with an error panel on a page employees use daily.
    """

    queryset = Refund.objects.all()
    serializer_class = RefundSerializer
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'student')
    permission_classes = [ScopedObjectPermission, CanManageRefunds, SubscriptionActive]
    filterset_class = RefundFilter
    # A refund is looked for by WHO it is for, so the registration's name is
    # searched first; `reason` is the only other free text on the row.
    # `student_name` is not a column on Refund -- it is read through the FK,
    # and Registration.student_name is a plain indexed CharField (unlike
    # `date_of_birth`, which is encrypted and can never be searched).
    search_fields = ('student__student_name', 'reason')
    ordering_fields = ('created_at', 'amount', 'status', 'processed_at')


class VisaTrackingViewSet(ScopedModelViewSet):
    queryset = VisaTracking.objects.all()
    serializer_class = VisaTrackingSerializer
    entity_type = 'visa_tracking'
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'student')
    filterset_fields = ('current_stage', 'status', 'branch', 'country')
    search_fields = ('student_name', 'country', 'visa_type')
    ordering_fields = ('created_at', 'current_stage', 'interview_date')


class FollowUpViewSet(ScopedModelViewSet):
    queryset = FollowUp.objects.all()
    serializer_class = FollowUpSerializer
    entity_type = 'follow_up'
    select_related_fields = (
        'company', 'branch', 'created_by', 'owner', 'enquiry', 'assigned_to',
    )
    filterset_class = FollowUpFilter
    # The board had no search box because this tuple did not exist: DRF discards
    # an unrecognised `?search=`, answers 200 with the full page, and the user
    # reads that as "everything matched". A follow-up is looked for by WHO it is
    # about, so the student's name is the first thing searched -- `notes` alone
    # would miss the obvious query.
    search_fields = (
        'enquiry__candidate_name', 'enquiry__mobile', 'enquiry__email', 'notes',
    )
    ordering_fields = ('scheduled_for', 'status', 'priority', 'created_at')


class FollowUpCommentViewSet(ScopedModelViewSet):
    """The discussion thread on a follow-up. Append-only, like remarks."""

    queryset = FollowUpComment.objects.all()
    serializer_class = FollowUpCommentSerializer
    select_related_fields = (
        'company', 'branch', 'created_by', 'owner', 'author', 'follow_up',
    )
    filterset_fields = ('follow_up',)
    ordering_fields = ('created_at',)
    search_fields = ('comment',)

    def perform_create(self, serializer):
        super().perform_create(serializer)
        serializer.instance.author = self.request.user
        serializer.instance.save(update_fields=['author'])

    def perform_update(self, serializer):
        raise PermissionDenied(
            'Comments record what was said at the time and cannot be edited. '
            'Add a new comment instead.'
        )

    def perform_destroy(self, instance):
        # Blocking edit but allowing delete would leave the append-only
        # rationale half-enforced: anyone who wanted to rewrite the record
        # could simply delete and re-add. Correct by adding, not removing.
        raise PermissionDenied(
            'Comments cannot be deleted. Add a correcting comment instead.'
        )


class StudentRemarkViewSet(ScopedModelViewSet):
    """Append-only commentary on a student's file."""

    queryset = StudentRemark.objects.all()
    serializer_class = StudentRemarkSerializer
    select_related_fields = ('company', 'branch', 'created_by', 'owner', 'user', 'registration')
    filterset_fields = ('registration',)
    ordering_fields = ('created_at',)
    search_fields = ('remark',)

    def perform_create(self, serializer):
        super().perform_create(serializer)
        serializer.instance.user = self.request.user
        serializer.instance.save(update_fields=['user'])

    def perform_update(self, serializer):
        raise PermissionDenied(
            'Remarks are a record of what was believed at the time and cannot '
            'be edited. Add a new remark instead.'
        )

    def perform_destroy(self, instance):
        # Same reasoning as edit: allowing delete would make the append-only
        # guarantee cosmetic.
        raise PermissionDenied(
            'Remarks cannot be deleted. Add a correcting remark instead.'
        )


class StudentDocumentViewSet(ScopedModelViewSet):
    """
    Custody of a student's ORIGINAL physical documents.

    Separate from DocumentViewSet, which handles uploaded scans. This answers
    "who is holding the passport", which is a liability question.
    """

    queryset = StudentDocument.objects.all()
    serializer_class = StudentDocumentSerializer
    entity_type = None
    select_related_fields = (
        'company', 'branch', 'created_by', 'owner', 'registration', 'current_holder',
    )
    filterset_fields = ('registration', 'status', 'current_holder')
    search_fields = ('name', 'document_number', 'registration__student_name')
    ordering_fields = ('received_at', 'returned_at', 'status')

    def perform_create(self, serializer):
        super().perform_create(serializer)
        # Whoever takes the document in is holding it until stated otherwise.
        if not serializer.instance.current_holder_id:
            serializer.instance.current_holder = self.request.user
            serializer.instance.save(update_fields=['current_holder'])

    @action(detail=False, methods=['post'], url_path='return-docs')
    @transaction.atomic
    def return_docs(self, request):
        """
        Mark a batch of originals as handed back to the student.

        Scoped through get_queryset, so ids outside the caller's scope are
        silently absent rather than actionable â€” and the count returned tells
        the caller how many were actually affected rather than implying all of
        them were.
        """
        ids = request.data.get('document_ids') or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({'document_ids': 'Provide a list of document ids.'})

        qs = self.get_queryset().filter(
            pk__in=ids,
        ).exclude(status=StudentDocument.Status.RETURNED)
        matched = list(qs)
        updated = qs.update(
            status=StudentDocument.Status.RETURNED,
            returned_at=timezone.now(),
            current_holder=None,
        )
        security_log.info(
            '%s returned %s original document(s) to students', request.user.username, updated,
        )
        return Response({
            'returned': updated,
            'requested': len(ids),
            'ids': [d.pk for d in matched],
        })


# ===========================================================================
#  Transfers
# ===========================================================================

class RecordTransferViewSet(viewsets.ModelViewSet):
    queryset = RecordTransfer.objects.select_related('from_user', 'to_user', 'company')
    serializer_class = RecordTransferSerializer
    permission_classes = [IsAuthenticatedAndActive, SubscriptionActive]
    filterset_fields = ('status', 'entity_type', 'from_user', 'to_user')
    ordering_fields = ('created_at', 'status')

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        if user.is_dev_admin:
            return qs
        qs = qs.filter(company_id=user.company_id)
        if user.is_company_admin:
            return qs
        if user.is_head_manager or user.is_branch_manager:
            return qs.filter(
                Q(branch_id__in=branch_ids_for(user)) | Q(from_user=user) | Q(to_user=user)
            )
        return qs.filter(Q(from_user=user) | Q(to_user=user))

    def perform_create(self, serializer):
        try:
            transfer = services.create_transfer(
                actor=self.request.user,
                entity_type=serializer.validated_data['entity_type'],
                entity_id=serializer.validated_data['entity_id'],
                to_user=serializer.validated_data['to_user'],
                note=serializer.validated_data.get('note', ''),
            )
        except DjangoValidationError as exc:
            raise ValidationError({'error': exc.messages[0]})
        serializer.instance = transfer

    @action(detail=True, methods=['post'])
    def accept(self, request, pk=None):
        transfer = self.get_object()
        if transfer.to_user_id != request.user.id:
            raise PermissionDenied('Only the recipient can accept a transfer.')
        if transfer.status != RecordTransfer.Status.PENDING:
            raise ValidationError({'error': 'This transfer has already been resolved.'})
        services.apply_transfer(transfer)
        return Response(self.get_serializer(transfer).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        transfer = self.get_object()
        if transfer.to_user_id != request.user.id:
            raise PermissionDenied('Only the recipient can reject a transfer.')
        if transfer.status != RecordTransfer.Status.PENDING:
            raise ValidationError({'error': 'This transfer has already been resolved.'})
        transfer.status = RecordTransfer.Status.REJECTED
        transfer.resolved_at = timezone.now()
        transfer.save(update_fields=['status', 'resolved_at'])
        return Response(self.get_serializer(transfer).data)

    @action(detail=False, methods=['get'])
    def inbox(self, request):
        """Transfers awaiting this user's decision."""
        return self._page(self.get_queryset().filter(
            to_user=request.user, status=RecordTransfer.Status.PENDING,
        ))

    @action(detail=False, methods=['get'])
    def outbox(self, request):
        """
        Transfers this user has sent.

        Without this, both directions arrive mixed in one paginated list (the
        employee queryset is from_user OR to_user) with no way to split them
        server-side.
        """
        return self._page(self.get_queryset().filter(from_user=request.user))

    def _page(self, qs):
        page = self.paginate_queryset(qs)
        if page is not None:
            return self.get_paginated_response(self.get_serializer(page, many=True).data)
        return Response(self.get_serializer(qs, many=True).data)


# ===========================================================================
#  Onboarding and approvals
# ===========================================================================

class SignupRequestViewSet(viewsets.ModelViewSet):
    queryset = SignupRequest.objects.select_related('plan', 'approved_by')
    serializer_class = SignupRequestSerializer
    ordering_fields = ('requested_at', 'status')

    def get_permissions(self):
        # Public signup is intentional; everything else is dev-admin only.
        # Previously the whole viewset was anonymous, exposing every
        # prospect's contact details and allowing a rejected request to be
        # flipped back to pending.
        if self.action == 'create':
            return [AllowAny()]
        return [IsDevAdmin()]

    def get_throttles(self):
        if self.action == 'create':
            self.throttle_scope = 'signup'
        return super().get_throttles()

    def perform_create(self, serializer):
        from django.contrib.auth.hashers import make_password
        serializer.save(password=make_password(serializer.validated_data['password']))

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def approve(self, request, pk=None):
        signup = self.get_object()
        if signup.status != 'Pending':
            raise ValidationError({'error': 'This request has already been processed.'})
        if User.objects.filter(username=signup.username).exists():
            raise ValidationError({'error': 'That username is already taken.'})

        company, branch = services.provision_company(
            name=signup.company_name, plan=signup.plan,
            email=signup.email, phone=signup.phone,
        )
        admin = User(
            username=signup.username,
            email=signup.email,
            first_name=signup.first_name,
            last_name=signup.last_name,
            role=Role.COMPANY_ADMIN,
            company=company,
            branch=branch,
        )
        # Already a hash from perform_create; assign directly rather than
        # re-hashing, and never store the raw value.
        admin.password = signup.password
        admin.save()

        signup.status = 'Approved'
        signup.approved_at = timezone.now()
        signup.approved_by = request.user
        signup.created_company = company
        signup.save(update_fields=[
            'status', 'approved_at', 'approved_by', 'created_company',
        ])
        return Response({'status': 'approved', 'company': company.id, 'user': admin.id})

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        signup = self.get_object()
        if signup.status != 'Pending':
            raise ValidationError({'error': 'This request has already been processed.'})
        signup.status = 'Rejected'
        signup.rejection_reason = request.data.get('reason', '')
        signup.save(update_fields=['status', 'rejection_reason'])
        return Response({'status': 'rejected'})


class ApprovalRequestViewSet(viewsets.ModelViewSet):
    queryset = ApprovalRequest.objects.select_related('requested_by', 'reviewed_by', 'company')
    serializer_class = ApprovalRequestSerializer
    # Anyone active may raise a request — that is the employee's route to a
    # delete. `approve`/`reject` are gated separately by `_require_reviewer`.
    # The DRF default here was bare `IsAuthenticated`, which ignores
    # `is_active_employee`.
    permission_classes = [IsAuthenticatedAndActive]
    ordering_fields = ('created_at', 'status')

    # Fields an approved UPDATE may touch, per entity. Everything else is
    # ignored. Previously `pending_changes` was applied with a bare setattr
    # loop over arbitrary client JSON, which could rewrite company_id or zero
    # out fees.
    MUTABLE_FIELDS = {
        'enquiry': {'status', 'course_interested', 'mobile', 'email', 'permanent_address'},
        'registration': {'student_name', 'mobile', 'email', 'payment_status', 'registration_fee'},
        'enrollment': {'program_name', 'status', 'start_date', 'duration_months'},
        'payment': {'status', 'method', 'reference'},
        'document': {'type', 'status', 'expiry_date'},
        'task': {'title', 'description', 'status', 'priority', 'due_date'},
        'appointment': {'status', 'date', 'notes'},
        'follow_up': {'status', 'priority', 'notes', 'scheduled_for'},
    }

    def get_queryset(self):
        user = self.request.user
        qs = super().get_queryset()
        if user.is_dev_admin:
            return qs
        qs = qs.filter(company_id=user.company_id)
        if user.is_company_admin:
            return qs
        if user.is_head_manager or user.is_branch_manager:
            return qs.filter(Q(branch_id__in=branch_ids_for(user)) | Q(requested_by=user))
        return qs.filter(requested_by=user)

    def perform_create(self, serializer):
        user = self.request.user
        # Route the request to the branch that owns the TARGET record, so it
        # reaches the manager who actually controls it rather than the
        # requester's own manager.
        target_branch = serializer.validated_data.pop('_target_branch_id', None)
        serializer.save(
            requested_by=user,
            company_id=user.company_id,
            branch_id=target_branch or user.branch_id,
        )

    def _require_reviewer(self):
        """
        Reviewing is `reviewApprovals`, resolved through the company's matrix.

        Its default is the previous hardcoded set (admins plus both manager
        tiers), and its floor is BRANCH_MANAGER — the queue exists to put a
        second person between an employee and a deletion, so an employee who
        could review would be approving their own requests.
        """
        user = self.request.user
        if not role_has(user, Capability.REVIEW_APPROVALS):
            raise PermissionDenied('Your role cannot review approval requests.')
        return user

    @action(detail=False, methods=['get'], url_path='pending-count')
    def pending_count(self, request):
        return Response({
            'count': self.get_queryset().filter(status=ApprovalRequest.Status.PENDING).count()
        })

    @action(detail=False, methods=['get'], url_path='my-requests')
    def my_requests(self, request):
        """
        Requests raised BY the caller, as opposed to ones awaiting their review.

        A manager's queryset contains both, so without this the employee-facing
        "my requests" view and the reviewer's inbox would show the same rows.
        """
        qs = self.get_queryset().filter(requested_by=request.user)
        page = self.paginate_queryset(qs)
        if page is not None:
            return self.get_paginated_response(self.get_serializer(page, many=True).data)
        return Response(self.get_serializer(qs, many=True).data)

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def approve(self, request, pk=None):
        """
        Apply the requested change.

        Two prior defects are closed here: the target is re-verified against
        the reviewer's own company (it was previously fetched with a bare
        lookup, letting a request point at another tenant's record), and the
        status is written only AFTER the action succeeds, inside a transaction
        (it was previously saved as APPROVED before the attempt, so a failure
        left an audit trail asserting something that never happened).
        """
        reviewer = self._require_reviewer()
        approval = self.get_object()
        if approval.status != ApprovalRequest.Status.PENDING:
            raise ValidationError({'error': 'This request has already been reviewed.'})

        obj = services.resolve_entity(approval.entity_type, approval.entity_id)
        if obj is None:
            raise ValidationError({'error': 'The target record no longer exists.'})
        # Check the reviewer's FULL write scope, not just the company.
        #
        # Comparing company alone left the confused deputy intact one level
        # down: a Kohima employee could file a deletion naming a Dimapur
        # record, and because the request is stamped with the *requester's*
        # branch it surfaced in the Kohima manager's queue, who could approve
        # the destruction of a record in a branch they do not control.
        if not can_write_object(reviewer, obj, approval.entity_type):
            security_log.warning(
                'Out-of-scope approval blocked: request %s by %s targeted %s#%s '
                '(company %s, branch %s)',
                approval.pk, reviewer.username, approval.entity_type,
                approval.entity_id, getattr(obj, 'company_id', None),
                getattr(obj, 'branch_id', None),
            )
            raise PermissionDenied('You cannot act on that record.')

        if approval.action == ApprovalRequest.Action.DELETE:
            obj.delete()
        else:
            allowed = self.MUTABLE_FIELDS.get(approval.entity_type, set())
            applied = []
            for raw_field, value in (approval.pending_changes or {}).items():
                field = _camel_to_snake(raw_field)
                if field in allowed:
                    setattr(obj, field, value)
                    applied.append(field)
            if not applied:
                raise ValidationError(
                    {'error': 'No permitted fields were included in this request.'}
                )
            obj.save()

        approval.status = ApprovalRequest.Status.APPROVED
        approval.reviewed_by = reviewer
        approval.reviewed_at = timezone.now()
        approval.review_note = request.data.get('note', '')
        approval.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_note'])
        return Response(self.get_serializer(approval).data)

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        reviewer = self._require_reviewer()
        approval = self.get_object()
        if approval.status != ApprovalRequest.Status.PENDING:
            raise ValidationError({'error': 'This request has already been reviewed.'})
        approval.status = ApprovalRequest.Status.REJECTED
        approval.reviewed_by = reviewer
        approval.reviewed_at = timezone.now()
        approval.review_note = request.data.get('note', '')
        approval.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_note'])
        return Response(self.get_serializer(approval).data)


# ===========================================================================
#  Role permissions
# ===========================================================================

class MyCapabilitiesView(APIView):
    """
    The capabilities the CALLER's role currently holds.

    The frontend's static `CAN` map (rbac/roles.ts) is a copy of the defaults
    and cannot know about a company's overrides, so a capability an admin has
    granted would be enforced by the server and still hidden by the UI. This is
    what closes that gap: the client merges this list over its defaults.

    Cheap on purpose — one cached dict lookup, no query in the common case.
    """

    permission_classes = [IsAuthenticatedAndActive]

    def get(self, request):
        return Response({
            'role': request.user.role,
            'capabilities': capabilities.capabilities_for(request.user),
        })


class RolePermissionView(APIView):
    """
    The role x capability grid for one company: read it, and change it.

    A single resource rather than a collection of rows, because the grid is
    what the admin reasons about. That shape also makes the two things that
    matter cheap: one GET renders the whole screen, and one PUT applies a batch
    of changes atomically and invalidates the company's cache exactly once.

    Not registered on the DRF router deliberately — it is not a queryset — so
    `path()` entries in urls.py expose it.

    A DEV_ADMIN has no company of their own and must name one with `?company=`.
    Without it they get the built-in defaults, read-only, which is the honest
    answer to "what does this look like before anyone configures it".
    """

    permission_classes = [IsCompanyAdmin]

    # ------------------------------------------------------------- resolution
    def _target_company(self, request):
        """
        Which company's grid is being read or written.

        A non-dev-admin is pinned to their own, whatever the query string says.
        Honouring `?company=` for them would be a one-parameter cross-tenant
        read of another customer's authorization configuration.
        """
        user = request.user
        if not user.is_dev_admin:
            return user.company

        requested = request.query_params.get('company') or request.data.get('company')
        if not requested:
            return None
        try:
            return Company.objects.get(pk=requested)
        except (Company.DoesNotExist, ValueError, TypeError):
            raise ValidationError({'company': 'No such company.'})

    def _cell(self, actor, company, role, capability, resolved, overridden):
        """One rendered cell: its value, where the value came from, and whether
        this actor may change it — with the reason when they may not."""
        allowed = resolved[role][capability.value]
        is_override = (role, capability.value) in overridden

        if role == Role.DEV_ADMIN:
            # `can_grant`/`can_revoke` are sent here too, false, rather than
            # omitted. A client that declares them as always-present and gets
            # `undefined` type-checks perfectly and reads the wrong value at
            # runtime; every cell having the same shape removes that trap.
            return {
                'allowed': True,
                'source': 'platform',
                'editable': False,
                'can_grant': False,
                'can_revoke': False,
                'reason': (
                    'Platform administrators always hold every capability. '
                    'This is not configurable by a tenant.'
                ),
            }

        can_grant, can_revoke, reason = True, True, ''

        if not capabilities.is_delegable_to(capability, role):
            can_grant = False
            floor = capabilities.floor_for(capability)
            # Short on purpose. The full rationale travels once per capability
            # as `protection_reason`; repeating it in all five cells of a row
            # would print the same paragraph five times on a phone.
            reason = f'Cannot be granted below {Role(floor).label}.'
        if company is None:
            can_grant = can_revoke = False
            reason = reason or 'Choose a company to configure its permissions.'

        return {
            'allowed': allowed,
            'source': 'override' if is_override else 'default',
            # Direction-aware: a cell that is on and may not be revoked is
            # locked, and so is a cell that is off and may not be granted.
            'editable': can_revoke if allowed else can_grant,
            'can_grant': can_grant,
            'can_revoke': can_revoke,
            'reason': reason,
        }

    def _payload(self, request, company):
        actor = request.user
        resolved = capabilities.resolve(company.pk if company else None)

        overridden = set()
        if company:
            overridden = {
                (role, capability)
                for role, capability in RolePermission.objects.filter(
                    company=company,
                ).values_list('role', 'capability')
            }

        return {
            'company': company.pk if company else None,
            'company_name': company.name if company else None,
            'roles': [
                {'value': role, 'label': Role(role).label}
                for role in capabilities.ALL_ROLES
            ],
            'capabilities': [
                {
                    'value': capability.value,
                    'label': capability.label,
                    'floor': capabilities.floor_for(capability),
                    'protection_reason': capabilities.protection_reason(capability),
                    'default_roles': [
                        str(r) for r in capabilities.DEFAULTS[capability]
                    ],
                }
                for capability in Capability
            ],
            'matrix': {
                role: {
                    capability.value: self._cell(
                        actor, company, role, capability, resolved, overridden,
                    )
                    for capability in Capability
                }
                for role in capabilities.ALL_ROLES
            },
        }

    # ------------------------------------------------------------------ verbs
    def get(self, request):
        return Response(self._payload(request, self._target_company(request)))

    def put(self, request):
        company = self._target_company(request)
        if company is None:
            raise ValidationError({
                'company': 'Name the company whose permissions you are changing.',
            })

        serializer = RolePermissionUpdateSerializer(
            data=request.data,
            context={'actor': request.user, 'company': company, 'request': request},
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()

        security_log.info(
            'Role permissions changed for company %s by %s: %s',
            company.pk, request.user.username,
            [
                (c['role'], c['capability'], c['allowed'])
                for c in serializer.validated_data['changes']
            ],
        )
        return Response(self._payload(request, company))

    def delete(self, request):
        """Drop every override and return the company to the built-in defaults."""
        company = self._target_company(request)
        if company is None:
            raise ValidationError({
                'company': 'Name the company whose permissions you are resetting.',
            })
        removed, _ = RolePermission.objects.filter(company=company).delete()
        capabilities.invalidate(company.pk)
        security_log.info(
            'Role permissions reset for company %s by %s (%s rows)',
            company.pk, request.user.username, removed,
        )
        return Response(self._payload(request, company))


# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKeyViewSet(viewsets.GenericViewSet):
    """
    List, mint and revoke personal API keys.

    Three rules:
      * A key is only ever created for the CALLER. There is no "create a key
        for user X" — an admin who wants to act as a user asks them for a key.
      * A session authenticated BY an API key cannot manage keys at all, so a
        leaked key cannot mint a longer-lived replacement for itself.
      * `?user=<id>` lists (and `revoke` reaches) another user's keys only for
        company admins inside their own company and for dev admins.
    """

    serializer_class = ApiKeySerializer
    permission_classes = [IsAuthenticatedAndActive]
    ordering_fields = ('created_at', 'name', 'last_used_at')

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        from oauth2_provider.models import AccessToken
        if isinstance(getattr(request, 'auth', None), (ApiKey, AccessToken)):
            raise PermissionDenied('Access keys cannot be managed through a delegated connection. Sign in with your password.')

    def _target_user(self):
        """The user whose keys the caller is asking about, after the scope check."""
        request = self.request
        raw = request.query_params.get('user')
        if not raw:
            return request.user
        try:
            target_id = int(raw)
        except (TypeError, ValueError):
            raise ValidationError({'user': 'user must be a number.'})
        if target_id == request.user.id:
            return request.user
        if request.user.is_dev_admin:
            return User.objects.filter(pk=target_id).first() or request.user
        # `company_id` is nullable, so the role alone is not a tenant. Without
        # this guard a COMPANY_ADMIN with no company would match company_id=None
        # — which is exactly the set of dev admins. Same rule as scope_queryset:
        # a non-dev-admin with no company sees nothing but their own.
        if request.user.is_company_admin and request.user.company_id:
            target = User.objects.filter(pk=target_id, company_id=request.user.company_id).first()
            if target is None:
                raise PermissionDenied('That user is not in your company.')
            return target
        raise PermissionDenied('You can only see your own API keys.')

    def get_queryset(self):
        user = self.request.user
        qs = ApiKey.objects.select_related('user')
        if self.action == 'list':
            return qs.filter(user=self._target_user())
        # Detail actions: own keys, plus company staff for admins, everything for dev admins.
        if user.is_dev_admin:
            return qs
        if user.is_company_admin and user.company_id:
            return qs.filter(user__company_id=user.company_id)
        return qs.filter(user=user)

    def list(self, request):
        qs = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(qs)
        if page is not None:
            return self.get_paginated_response(self.get_serializer(page, many=True).data)
        return Response(self.get_serializer(qs, many=True).data)

    def create(self, request):
        serializer = ApiKeyCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key, raw = ApiKey.issue(
            request.user, serializer.validated_data['name'],
            expires_at=serializer.validated_data.get('expires_at'),
        )
        security_log.info('API key %s created by %s', key.prefix, request.user.username)
        data = ApiKeySerializer(key).data
        data['key'] = raw
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def revoke(self, request, pk=None):
        key = self.get_object()
        key.revoke()
        security_log.info('API key %s revoked by %s', key.prefix, request.user.username)
        return Response(ApiKeySerializer(key).data)


# ===========================================================================
#  Health
# ===========================================================================

class HealthView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        from django.db import connection
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1')
            return Response({'status': 'ok'})
        except Exception:
            logger.error('Health check failed', exc_info=True)
            return Response({'status': 'degraded'}, status=503)
