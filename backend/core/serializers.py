"""
Serializers.

Every serializer here declares an explicit field list. The previous version used
`fields = '__all__'` on roughly twenty models, which made every column
client-writable â€” including `company_id` (the tenant boundary), `created_by`
(the audit trail), and `role` (which allowed any user to PATCH themselves to
DEV_ADMIN). Tenancy and ownership fields are set by the view from the request
user, never accepted from the client.
"""

from decimal import Decimal

from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from django.db.models import Q
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.validators import UniqueTogetherValidator

from . import capabilities
from .models import (
    Agent, ApiKey, Appointment, ApprovalRequest, Branch, Capability, Commission,
    Company, Document,
    Enquiry, Enrollment, FollowUp, FollowUpComment, Installment,
    Notification,
    Payment, Plan, RecordTransfer, Refund, Registration, Role, RolePermission,
    SignupRequest,
    StudentDocument, StudentRemark, Subscription, Task, Template, University,
    User, VisaTracking,
)

# Fields the server owns on every tenant-scoped record.
SCOPE_READ_ONLY = ('company', 'branch', 'created_by', 'owner', 'created_at', 'updated_at')


class ScopedSerializer(serializers.ModelSerializer):
    """Adds human-readable labels and locks the server-owned fields."""

    company_name = serializers.CharField(source='company.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    created_by_name = serializers.SerializerMethodField()
    owner_name = serializers.SerializerMethodField()

    def get_created_by_name(self, obj):
        return obj.created_by.get_full_name() or obj.created_by.username if obj.created_by else 'â€”'

    def get_owner_name(self, obj):
        return obj.owner.get_full_name() or obj.owner.username if obj.owner else 'â€”'




class _OptionalRefUniqueTogetherValidator(UniqueTogetherValidator):
    """
    Uniqueness check that stands down when the reference number is absent.

    The stock validator first demands every constrained field be present
    (enforce_required_fields) and then indexes attrs by each of them, so a
    payload without the reference cannot get past it either way: neutralising
    only the required-check just moves the failure to a KeyError.

    Skipping it loses nothing, because on this serializer the check could
    never fire: `company` is read-only, so DRF injects it as None via
    _read_only_defaults(). filter_queryset then looks for `company IS NULL`,
    which matches no real row, and DRF skips the comparison outright when any
    checked value is None. The validator only ever enforced 'required'.

    Uniqueness is still guaranteed -- by the database constraint, which
    surfaces as a 409 rather than a 400.
    """

    def __call__(self, attrs, serializer):
        for field_name in self.fields:
            if serializer.fields[field_name].source not in attrs:
                return
        super().__call__(attrs, serializer)


class ServerAssignedRefMixin:
    """
    For records whose reference number (REG-..., ENR-...) is generated
    server-side by the viewset's perform_create when the client omits it.

    The model constrains ('company', <ref>) to be unique, so DRF builds a
    UniqueTogetherValidator from that constraint, and it runs during
    validation -- long before perform_create can generate anything. Every
    create that relied on generation therefore failed with
    "<ref>: This field is required."

    perform_create already tried to fix this and could not: it runs too late.
    """

    REF_FIELDS = ()

    def get_unique_together_validators(self):
        return [
            _OptionalRefUniqueTogetherValidator(
                queryset=validator.queryset,
                fields=validator.fields,
                message=validator.message,
                condition_fields=getattr(validator, 'condition_fields', None),
                condition=getattr(validator, 'condition', None),
                code=getattr(validator, 'code', None),
            )
            if set(self.REF_FIELDS) & set(validator.fields) else validator
            for validator in super().get_unique_together_validators()
        ]


# ===========================================================================
#  Tenancy and billing
# ===========================================================================

class BranchSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.name', read_only=True)
    user_count = serializers.IntegerField(read_only=True, default=0)
    manager_names = serializers.SerializerMethodField()

    class Meta:
        model = Branch
        fields = (
            'id', 'company', 'company_name', 'name', 'code', 'city', 'address',
            'phone', 'is_active', 'is_default', 'user_count', 'manager_names',
            'created_at',
        )
        read_only_fields = ('company', 'created_at', 'is_default')

    def get_manager_names(self, obj):
        return [
            u.get_full_name() or u.username
            for u in obj.users.filter(role=Role.BRANCH_MANAGER)
        ]


class PlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = Plan
        fields = (
            'id', 'name', 'slug', 'price_monthly', 'currency', 'max_branches',
            'max_users', 'features', 'is_active', 'sort_order',
        )


class SubscriptionSerializer(serializers.ModelSerializer):
    plan_name = serializers.CharField(source='plan.name', read_only=True)
    company_name = serializers.CharField(source='company.name', read_only=True)
    days_remaining = serializers.IntegerField(read_only=True)
    is_usable = serializers.BooleanField(read_only=True)

    class Meta:
        model = Subscription
        fields = (
            'id', 'company', 'company_name', 'plan', 'plan_name', 'status',
            'trial_ends_at', 'current_period_start', 'current_period_end',
            'cancelled_at', 'days_remaining', 'is_usable',
        )
        read_only_fields = ('company', 'cancelled_at')


class CompanySerializer(serializers.ModelSerializer):
    subscription = SubscriptionSerializer(read_only=True)
    branch_count = serializers.IntegerField(read_only=True, default=0)
    user_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Company
        fields = (
            'id', 'name', 'slug', 'email', 'phone', 'address', 'is_active',
            'subscription', 'branch_count', 'user_count', 'created_at',
        )
        read_only_fields = ('slug', 'created_at')


class CompanyProfileSerializer(CompanySerializer):
    """
    What a COMPANY_ADMIN may change about their own company: the profile.

    Editable: name, email, phone, address — exactly the four the Settings page
    sends (settings/page.tsx:251-256).

    `is_active` is added to the read-only set because it is the suspension
    switch: a tenant the operator has disabled must not be able to re-enable
    itself. `slug` (the tenant key) and `id` were already read-only, and
    `subscription` is a nested read-only serializer, so the plan and its seat
    and branch caps are unreachable from here — a company admin cannot lift
    their own limits.

    Handed out by `CompanyViewSet.get_serializer_class` on the CALLER's
    capability, never on the action. Choosing by action is the trap in
    HIERARCHY_BUILD_PROMPT.md section 2 item 2: `update` is the action every
    caller uses on their own row, so keying on it hands the permissive
    serializer to precisely the people it was meant to exclude.
    """

    class Meta(CompanySerializer.Meta):
        read_only_fields = CompanySerializer.Meta.read_only_fields + ('is_active',)


# ===========================================================================
#  Users
# ===========================================================================

class UserSerializer(serializers.ModelSerializer):
    """
    `role`, `company` and `branch` are deliberately NOT writable here. They are
    assigned through UserViewSet's admin-only create/update paths, which check
    that the caller may grant them. Leaving `role` writable is what allowed an
    employee to PATCH themselves to DEV_ADMIN.
    """

    company_name = serializers.CharField(source='company.name', read_only=True)
    branch_name = serializers.CharField(source='branch.name', read_only=True)
    full_name = serializers.SerializerMethodField()
    role_display = serializers.CharField(source='get_role_display', read_only=True)

    class Meta:
        model = User
        fields = (
            'id', 'username', 'email', 'first_name', 'last_name', 'full_name',
            'role', 'role_display', 'company', 'company_name', 'branch',
            'branch_name', 'phone', 'avatar', 'is_active', 'is_active_employee',
            'last_login', 'managed_managers',
        )
        read_only_fields = (
            'role', 'company', 'branch', 'is_active', 'is_active_employee', 'last_login',
            'managed_managers',
        )

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username


class UserAdminSerializer(UserSerializer):
    """Used by admins to create and manage staff. Role/branch are writable."""

    password = serializers.CharField(write_only=True, required=False, allow_blank=True)
    managed_managers = serializers.PrimaryKeyRelatedField(
        many=True, required=False, queryset=User.objects.none(),
    )

    class Meta(UserSerializer.Meta):
        # `managed_managers` is already on the parent (read-only there); this
        # serializer redeclares it above as writable, so it must not be added
        # to the tuple a second time.
        fields = UserSerializer.Meta.fields + ('password',)
        # Deliberately NARROWER than the parent's read-only set: an admin must
        # be able to set `role` and `branch`. This serializer is therefore only
        # ever handed to a caller for whom `can_manage_users` is true â€” see
        # UserViewSet.get_serializer_class. `company` stays locked so an admin
        # cannot move staff between tenants; `is_active_employee` is changed
        # through the set-active action so the change is auditable.
        read_only_fields = ('company', 'is_active', 'is_active_employee', 'last_login')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        # Legacy reporting links remain tenant-bound.
        if request and request.user.is_authenticated and request.user.company_id:
            # `managed_managers` is absent on the manager-facing subclass below,
            # so this is guarded rather than indexed blind.
            if 'managed_managers' in self.fields:
                self.fields['managed_managers'].child_relation.queryset = User.objects.filter(
                    company_id=request.user.company_id, role=Role.BRANCH_MANAGER,
                )
            self.fields['branch'].queryset = Branch.objects.filter(
                company_id=request.user.company_id,
            )

    def validate_password(self, value):
        if value:
            validate_password(value)
        return value

    def validate(self, attrs):
        role = attrs.get('role', getattr(self.instance, 'role', None))
        branch = attrs.get('branch', getattr(self.instance, 'branch', None))
        if role in (Role.BRANCH_MANAGER, Role.EMPLOYEE) and not branch:
            raise serializers.ValidationError(
                {'branch': 'A branch is required for branch managers and employees.'}
            )
        request = self.context.get('request')
        # Only a dev admin may mint another dev admin.
        if role == Role.DEV_ADMIN and request and not request.user.is_dev_admin:
            raise serializers.ValidationError(
                {'role': 'You cannot assign the platform administrator role.'}
            )
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        managers = validated_data.pop('managed_managers', [])
        password = validated_data.pop('password', None)
        user = User(**validated_data)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save()
        if managers:
            user.managed_managers.set(managers)
        return user

    @transaction.atomic
    def update(self, instance, validated_data):
        """
        The previous version had no update() at all, so DRF's default assigned
        the raw password string to the field and saved it â€” storing the
        password in plaintext AND making the account impossible to log into.
        """
        managers = validated_data.pop('managed_managers', None)
        password = validated_data.pop('password', None)

        # Identity claims ride on the refresh token and survive rotation, so a
        # role or branch change must invalidate outstanding sessions or it
        # takes up to REFRESH_TOKEN_LIFETIME to become visible.
        identity_changed = any(
            field in validated_data and validated_data[field] != getattr(instance, field)
            for field in ('role', 'branch', 'company')
        )

        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        if password:
            instance.set_password(password)
        instance.save()
        if managers is not None:
            instance.managed_managers.set(managers)

        if identity_changed or password:
            from .services import revoke_all_tokens
            revoke_all_tokens(instance)
        return instance


class UserManagerCreateSerializer(UserAdminSerializer):
    """
    A head or branch manager hiring an EMPLOYEE into a branch they run.

    The business asked for managers to be able to add staff. The naive way to
    grant that is to give managers `manageUsers`, which also lets them create a
    COMPANY_ADMIN — so `manageUsers` stays admin-only and non-delegable, and
    this much smaller right is expressed as its own serializer plus the checks
    in `UserViewSet.perform_create`.

    Two things are missing from `UserAdminSerializer` on purpose:

      * `managed_managers` — a legacy reporting field reserved for admins.
      * any authority over `role` or `branch` beyond what the view allows. Those
        stay writable here (a manager has to be able to say which of their
        branches the hire belongs to) and the VIEW is what constrains the
        values: EMPLOYEE only, and only into `branch_ids_for(actor)`.

    HIERARCHY_BUILD_PROMPT.md §2.2 says to choose the serializer by CALLER
    CAPABILITY rather than by action, and this class does not break that rule.
    The defect it warns about is a permissive serializer reaching a caller's OWN
    row, letting them PATCH themselves to a higher role. `create` has no
    existing row to reach, and this serializer cannot mint anything but an
    employee in a branch the caller already controls — so the view selects it
    for `create` only, and managers keep the read-only `UserSerializer` for
    every update, including their own profile.
    """

    managed_managers = None

    class Meta(UserAdminSerializer.Meta):
        fields = tuple(
            name for name in UserAdminSerializer.Meta.fields
            if name != 'managed_managers'
        )

    def validate(self, attrs):
        """
        EMPLOYEE only, refused as 403 rather than 400.

        This runs BEFORE the parent's checks on purpose. The parent refuses
        DEV_ADMIN with a 400, which would make "a manager tried to create an
        admin" answer 400 for one role and 403 for the other three — the same
        refusal reported two ways, which is the kind of inconsistency that
        makes a test suite assert whatever the code happens to do. Every
        role a manager may not create now answers 403.

        `PermissionDenied` (not `ValidationError`) is deliberate: DRF's
        `run_validation` only converts ValidationError, so this propagates to
        the view's exception handler and becomes a 403.
        `UserViewSet.perform_create` re-checks it regardless — this class exists
        to produce the right status, not to be the security boundary.
        """
        role = attrs.get('role', getattr(self.instance, 'role', Role.EMPLOYEE))
        if role != Role.EMPLOYEE:
            raise PermissionDenied(
                'Managers can only create employee accounts. Ask a company '
                'admin to add a manager or an admin.'
            )
        return super().validate(attrs)


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True)

    def validate_new_password(self, value):
        validate_password(value, user=self.context['request'].user)
        return value

    def validate_current_password(self, value):
        if not self.context['request'].user.check_password(value):
            raise serializers.ValidationError('Current password is incorrect.')
        return value


# ===========================================================================
#  Role permissions
# ===========================================================================

class RolePermissionChangeSerializer(serializers.Serializer):
    """
    One cell of the grid, as submitted by the permissions screen.

    `allowed` is nullable and null is meaningful: it deletes the override and
    returns the cell to its built-in default. Without it there would be no way
    back from an explicit choice to "whatever the product ships with", and an
    admin experimenting on a Friday could not undo it.
    """

    role = serializers.ChoiceField(choices=Role.choices)
    capability = serializers.ChoiceField(choices=Capability.choices)
    allowed = serializers.BooleanField(allow_null=True)


class RolePermissionUpdateSerializer(serializers.Serializer):
    """
    A batch of cell changes, validated against the delegation rules.

    Every rule here is also applied when the matrix is RESOLVED
    (core/capabilities.py), so this class is the place that produces a readable
    error rather than the place that keeps the system safe. Both matter: a
    silent clamp on read would leave the admin looking at a toggle that appears
    to have saved and provably did nothing.

    `actor` and `company` come from the view, never from the payload.
    """

    changes = RolePermissionChangeSerializer(many=True, allow_empty=True)

    def validate_changes(self, changes):
        """
        Refuse the WHOLE batch if any cell is refused.

        The grid the admin submitted is the unit of intent; applying the
        acceptable half would leave a permission state nobody chose and no
        error message explaining the difference.

        Errors come back as a flat list of finished sentences, each naming its
        own cell. A per-index dict would arrive at the browser as
        `{"changes": {"0": [...]}}`, which the shared error formatter renders as
        `changes: [object Object]` — a refusal the admin cannot act on.
        """
        actor = self.context['actor']
        company = self.context['company']
        refusals = []

        for change in changes:
            role = change['role']
            capability = Capability(change['capability'])
            allowed = change['allowed']

            problem = self._reject(actor, company, role, capability, allowed)
            if problem:
                refusals.append(
                    f'{Role(role).label} / {capability.label}: {problem}'
                )

        if refusals:
            raise serializers.ValidationError(refusals)
        return changes

    @staticmethod
    def _reject(actor, company, role, capability, allowed):
        """The reason this change is refused, or None when it is acceptable."""
        if role == Role.DEV_ADMIN:
            return (
                'Platform administrator permissions are not configurable. '
                'A tenant cannot revoke its own vendor’s access.'
            )

        # Escalation guard 1: a protected capability cannot cross its floor.
        # Checked for grants only — revoking below the floor is a no-op, since
        # the resolver already refuses to hand it out there.
        if allowed and not capabilities.is_delegable_to(capability, role):
            floor = capabilities.floor_for(capability)
            return (
                f'{capability.label} cannot be granted below '
                f'{Role(floor).label}. {capabilities.protection_reason(capability)}'
            )

        # Escalation guard 2: you cannot hand out what you do not hold. Without
        # this an admin whose own role had a capability revoked could grant it
        # to a role they belong to and take it straight back.
        if allowed and not capabilities.role_has(actor, capability):
            return (
                f'You cannot grant {capability.label} because your own role '
                'does not hold it.'
            )

        # Lockout guard: the tenant must retain someone who can administer it.
        if (
            allowed is False
            and role == Role.COMPANY_ADMIN
            and capability in capabilities.ADMIN_ESSENTIALS
        ):
            return (
                f'{capability.label} cannot be taken away from a company '
                'admin — nobody inside the company could administer it '
                'afterwards, including undoing this change.'
            )

        if company is None:
            return 'Choose a company before changing its permissions.'

        return None

    @transaction.atomic
    def save(self, **kwargs):
        """
        Apply the batch, then invalidate the company's cached matrix ONCE.

        Atomic because a half-applied permission change is a state no admin
        asked for: the grid they submitted is the unit of intent.
        """
        actor = self.context['actor']
        company = self.context['company']

        for change in self.validated_data['changes']:
            role = change['role']
            capability = change['capability']
            allowed = change['allowed']

            if allowed is None:
                RolePermission.objects.filter(
                    company=company, role=role, capability=capability,
                ).delete()
                continue

            RolePermission.objects.update_or_create(
                company=company, role=role, capability=capability,
                defaults={'allowed': allowed, 'updated_by': actor},
            )

        capabilities.invalidate(company.pk)
        return company


# ===========================================================================
#  CRM
# ===========================================================================

class EnquirySerializer(ScopedSerializer):
    class Meta:
        model = Enquiry
        fields = (
            'id', 'date', 'school_name', 'stream', 'candidate_name',
            'course_interested', 'mobile', 'email', 'father_name', 'mother_name',
            'father_occupation', 'mother_occupation', 'father_mobile',
            'mother_mobile', 'permanent_address', 'preferred_locations',
            'other_location', 'status',
            # Academic and eligibility profile. The form always collected these;
            # until now there were no columns and they were discarded on save.
            'gender', 'date_of_birth', 'caste', 'religion',
            'family_place', 'family_state',
            'school_board', 'school_place', 'school_state',
            'class12_passing_year', 'class12_percentage',
            'class10_school_name', 'class10_board', 'class10_passing_year',
            'class10_place', 'class10_state', 'class10_percentage',
            'physics_marks', 'chemistry_marks', 'biology_marks', 'maths_marks',
            'pcb_percentage', 'pcm_percentage',
            'previous_neet_marks', 'present_neet_marks',
            'gap_year', 'gap_year_from', 'gap_year_to', 'college_dropout',
            'payment_amount',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class RegistrationSerializer(ServerAssignedRefMixin, ScopedSerializer):
    REF_FIELDS = ('registration_no',)

    enquiry_candidate = serializers.CharField(source='enquiry.candidate_name', read_only=True)
    # Server-assigned when omitted (services.next_reference_number).
    registration_no = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Registration
        fields = (
            'id', 'registration_no', 'student_name', 'mobile', 'email',
            'date_of_birth', 'father_name', 'mother_name', 'permanent_address',
            'registration_date', 'needs_loan', 'payment_status', 'payment_method',
            'registration_fee', 'preferences', 'enquiry', 'enquiry_candidate',
            # Student profile, mirroring Enquiry so a conversion carries the
            # details forward rather than losing them to a free-text log.
            'gender', 'caste', 'religion',
            'father_occupation', 'mother_occupation', 'father_mobile', 'mother_mobile',
            'family_place', 'family_state',
            'stream', 'school_name', 'school_board', 'school_place', 'school_state',
            'class12_passing_year', 'class12_percentage',
            'class10_school_name', 'class10_board', 'class10_passing_year',
            'class10_place', 'class10_state', 'class10_percentage',
            'physics_marks', 'chemistry_marks', 'biology_marks', 'maths_marks',
            'pcb_percentage', 'pcm_percentage',
            'previous_neet_marks', 'present_neet_marks',
            'gap_year', 'gap_year_from', 'gap_year_to', 'college_dropout',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY + ('registration_date',)


class InstallmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Installment
        fields = ('id', 'enrollment', 'number', 'due_date', 'amount', 'status', 'paid_at')
        read_only_fields = ('enrollment',)


class EnrollmentSerializer(ServerAssignedRefMixin, ScopedSerializer):
    REF_FIELDS = ('enrollment_no',)

    student_name = serializers.CharField(source='student.student_name', read_only=True)
    # Server-assigned when omitted (services.next_reference_number).
    enrollment_no = serializers.CharField(required=False, allow_blank=True)
    installments = InstallmentSerializer(many=True, read_only=True)
    # Write-side helpers for generating a payment schedule on create.
    installments_count = serializers.IntegerField(write_only=True, required=False, min_value=0)
    installment_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, write_only=True, required=False,
    )

    class Meta:
        model = Enrollment
        fields = (
            'id', 'enrollment_no', 'student', 'student_name', 'program_name',
            'university', 'university_name', 'country', 'start_date',
            'duration_months', 'total_fees', 'commission_amount', 'status',
            'installments', 'installments_count', 'installment_amount',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        # Scope the related dropdowns to the caller's company. Previously the
        # student field used Registration.objects.all(), which let a client
        # enumerate every tenant's students by trying ids and reading the
        # student name echoed back in the response.
        if request and request.user.is_authenticated and not request.user.is_dev_admin:
            self.fields['student'].queryset = Registration.objects.filter(
                company_id=request.user.company_id,
            )
            self.fields['university'].queryset = University.objects.filter(
                Q(company_id=request.user.company_id) | Q(company__isnull=True)
            )


class PaymentSerializer(ScopedSerializer):
    class Meta:
        model = Payment
        fields = (
            'id', 'registration', 'enrollment', 'installment', 'student_name',
            'amount', 'date', 'type', 'status', 'method', 'reference', 'metadata',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class DocumentSerializer(ScopedSerializer):
    download_url = serializers.SerializerMethodField()
    file = serializers.FileField(write_only=True, required=False)

    class Meta:
        model = Document
        fields = (
            'id', 'file_name', 'file', 'file_size', 'content_type', 'type',
            'status', 'uploaded_at', 'student_name', 'registration', 'enquiry',
            'expiry_date', 'download_url', 'is_encrypted',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY + (
            'file_size', 'content_type', 'uploaded_at', 'is_encrypted',
        )

    def validate_registration(self, value):
        request = self.context['request']
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('That student does not exist.')
        return value

    def validate_enquiry(self, value):
        request = self.context['request']
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('That student does not exist.')
        return value

    def validate(self, attrs):
        """
        Resolve `student_name` from the link rather than from the client.

        The upload form used to post a free-text name alongside a
        `registration_no` that was never a field here, so DRF dropped the
        reference and kept the name -- every document arrived unlinked, and the
        name it carried could drift from the record it claimed to describe.
        Deriving it here keeps the column useful for list and search without
        letting it contradict the row it points at.
        """
        attrs = super().validate(attrs)

        registration = attrs.get('registration', getattr(self.instance, 'registration', None))
        enquiry = attrs.get('enquiry', getattr(self.instance, 'enquiry', None))

        if registration and enquiry:
            raise serializers.ValidationError(
                'A document belongs to one student: name a registration or an '
                'enquiry, not both.'
            )

        if registration:
            attrs['student_name'] = registration.student_name
        elif enquiry:
            attrs['student_name'] = enquiry.candidate_name

        return attrs

    def get_download_url(self, obj):
        if not obj.file:
            return None
        return f'/api/documents/{obj.pk}/download/'


class TaskSerializer(ScopedSerializer):
    assigned_to_name = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = (
            'id', 'title', 'description', 'assigned_to', 'assigned_to_name',
            'due_date', 'priority', 'status', 'completed_at', 'position',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY

    def get_assigned_to_name(self, obj):
        return obj.assigned_to.get_full_name() or obj.assigned_to.username if obj.assigned_to else 'â€”'


class AppointmentSerializer(ScopedSerializer):
    counselor_name = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = (
            'id', 'student_name', 'student_email', 'counselor', 'counselor_name',
            'date', 'time', 'duration', 'type', 'status', 'notes',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY

    def get_counselor_name(self, obj):
        return obj.counselor.get_full_name() or obj.counselor.username if obj.counselor else 'â€”'


class UniversitySerializer(serializers.ModelSerializer):
    class Meta:
        model = University
        fields = (
            'id', 'company', 'name', 'country', 'city', 'ranking', 'programs',
            'tuition_fee_min', 'tuition_fee_max', 'admission_deadline',
            'requirements', 'rating',
        )
        read_only_fields = ('company',)


class TemplateSerializer(ScopedSerializer):
    class Meta:
        model = Template
        fields = (
            'id', 'name', 'template_type', 'category', 'subject', 'content',
            'variables', 'is_active',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class NotificationSerializer(serializers.ModelSerializer):
    """
    `user` is read-only: it was previously writable on an authenticated
    endpoint, letting any user plant a notification (with an arbitrary
    action_url) in an administrator's tray.
    """

    class Meta:
        model = Notification
        fields = ('id', 'title', 'message', 'type', 'is_read', 'action_url', 'created_at')
        read_only_fields = ('title', 'message', 'type', 'action_url', 'created_at')


class AgentSerializer(ScopedSerializer):
    class Meta:
        model = Agent
        fields = (
            'id', 'name', 'email', 'phone', 'commission_type', 'commission_value',
            'status', 'total_earned', 'pending_amount', 'students_referred',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        # Aggregates are derived by signals, never client-supplied.
        read_only_fields = SCOPE_READ_ONLY + (
            'total_earned', 'pending_amount', 'students_referred',
        )


class CommissionSerializer(ScopedSerializer):
    """
    A commission is a promise to pay a named agent a specific sum.

    Every field was effectively optional, so `POST /api/commissions/` with an
    empty body returned 201 and wrote a financial row with no agent, no
    student and a zero amount. That is not a partially-filled draft; it is a
    record that can never be reconciled against anything.

    `agent` and `commission_amount` are made required HERE rather than on the
    model. Commission.agent is `null=True` and both money columns default to 0
    (models.py:767-777), and rows written before this change may rely on that,
    so tightening the columns would need a migration and a data audit first.
    The serializer is the only path the API offers, and closing it costs
    nothing at rest. `student` and `enrollment` stay optional: a lump-sum
    referral payment is not always attached to one student.

    PATCH is unaffected — DRF skips `required` on a partial update — so the
    only client of this endpoint (marking a commission Paid, apiClient.ts:1398)
    keeps working.
    """

    agent_name = serializers.CharField(source='agent.name', read_only=True)
    student_name = serializers.CharField(source='student.student_name', read_only=True)
    agent = serializers.PrimaryKeyRelatedField(
        queryset=Agent.objects.all(), allow_null=False, required=True,
    )
    commission_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=Decimal('0.01'), required=True,
        error_messages={'min_value': 'A commission must be worth more than nothing.'},
    )

    class Meta:
        model = Commission
        fields = (
            'id', 'agent', 'agent_name', 'student', 'student_name', 'enrollment',
            'enrollment_fee', 'commission_amount', 'status', 'paid_at',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class RefundSerializer(ScopedSerializer):
    student_name = serializers.CharField(source='student.student_name', read_only=True)

    class Meta:
        model = Refund
        fields = (
            'id', 'student', 'student_name', 'payment', 'amount', 'reason',
            'status', 'processed_at',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class VisaTrackingSerializer(ScopedSerializer):
    class Meta:
        model = VisaTracking
        fields = (
            'id', 'student', 'student_name', 'passport_no', 'country',
            'visa_type', 'applied_date', 'current_stage', 'interview_date',
            'expected_decision', 'officer', 'notes', 'status',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY


class FollowUpSerializer(ScopedSerializer):
    assigned_to_name = serializers.SerializerMethodField()
    enquiry_candidate = serializers.CharField(source='enquiry.candidate_name', read_only=True)

    class Meta:
        model = FollowUp
        fields = (
            'id', 'enquiry', 'enquiry_candidate', 'assigned_to', 'assigned_to_name',
            'scheduled_for', 'type', 'status', 'priority', 'notes', 'completed_at',
            'outcome_status', 'admission_possibility',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY

    def get_assigned_to_name(self, obj):
        if not obj.assigned_to:
            return 'â€”'
        return obj.assigned_to.get_full_name() or obj.assigned_to.username


# ===========================================================================
#  Workflow
# ===========================================================================

class FollowUpCommentSerializer(ScopedSerializer):
    author_name = serializers.SerializerMethodField()

    class Meta:
        model = FollowUpComment
        fields = (
            'id', 'follow_up', 'author', 'author_name', 'comment',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        # `author` is stamped from the request: a comment attributed to someone
        # else is worse than no comment.
        read_only_fields = SCOPE_READ_ONLY + ('author',)

    def get_author_name(self, obj):
        if not obj.author:
            return 'â€”'
        return obj.author.get_full_name() or obj.author.username

    def validate_follow_up(self, value):
        request = self.context['request']
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('That follow-up does not exist.')
        return value


class StudentRemarkSerializer(ScopedSerializer):
    user_name = serializers.SerializerMethodField()

    class Meta:
        model = StudentRemark
        fields = (
            'id', 'registration', 'user', 'user_name', 'remark',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        # `user` is stamped from the request: a remark attributed to someone
        # else is worse than no remark at all.
        read_only_fields = SCOPE_READ_ONLY + ('user',)

    def get_user_name(self, obj):
        if not obj.user:
            return 'â€”'
        return obj.user.get_full_name() or obj.user.username

    def validate_registration(self, value):
        request = self.context['request']
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('That student does not exist.')
        return value


class StudentDocumentSerializer(ScopedSerializer):
    current_holder_name = serializers.SerializerMethodField()
    student_name = serializers.CharField(source='registration.student_name', read_only=True)

    class Meta:
        model = StudentDocument
        fields = (
            'id', 'registration', 'student_name', 'name', 'document_number',
            'status', 'received_at', 'returned_at', 'remarks',
            'current_holder', 'current_holder_name',
            'company', 'company_name', 'branch', 'branch_name',
            'created_by', 'created_by_name', 'owner', 'owner_name',
            'created_at', 'updated_at',
        )
        read_only_fields = SCOPE_READ_ONLY + ('returned_at',)

    def get_current_holder_name(self, obj):
        if not obj.current_holder:
            return 'â€”'
        return obj.current_holder.get_full_name() or obj.current_holder.username

    def validate_registration(self, value):
        request = self.context['request']
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('That student does not exist.')
        return value


class RecordTransferSerializer(serializers.ModelSerializer):
    from_user_name = serializers.SerializerMethodField()
    to_user_name = serializers.SerializerMethodField()

    class Meta:
        model = RecordTransfer
        fields = (
            'id', 'entity_type', 'entity_id', 'entity_label', 'from_user',
            'from_user_name', 'to_user', 'to_user_name', 'note', 'status',
            'requires_acceptance', 'created_at', 'resolved_at',
        )
        read_only_fields = (
            'from_user', 'status', 'resolved_at', 'entity_label',
            'requires_acceptance', 'created_at',
        )

    def get_from_user_name(self, obj):
        return obj.from_user.get_full_name() or obj.from_user.username

    def get_to_user_name(self, obj):
        return obj.to_user.get_full_name() or obj.to_user.username

    def validate_to_user(self, value):
        request = self.context['request']
        if value.id == request.user.id:
            raise serializers.ValidationError('You cannot transfer a record to yourself.')
        if not request.user.is_dev_admin and value.company_id != request.user.company_id:
            raise serializers.ValidationError('Recipient must belong to your company.')
        return value


class SignupRequestSerializer(serializers.ModelSerializer):
    """
    Public write, admin read. `status` and `password` are locked after creation:
    previously both were writable on an unauthenticated endpoint, so a rejected
    request could be flipped back to pending and its password rewritten in
    plaintext to yield a known-credential company admin on approval.
    """

    password = serializers.CharField(write_only=True)
    plan_name = serializers.CharField(source='plan.name', read_only=True)
    approved_by_name = serializers.SerializerMethodField()

    class Meta:
        model = SignupRequest
        fields = (
            'id', 'company_name', 'admin_name', 'email', 'phone', 'plan',
            'plan_name', 'username', 'password', 'first_name', 'last_name',
            'requested_at', 'status', 'approved_at', 'approved_by',
            'approved_by_name', 'rejection_reason',
        )
        read_only_fields = (
            'status', 'requested_at', 'approved_at', 'approved_by', 'rejection_reason',
        )

    def get_approved_by_name(self, obj):
        return obj.approved_by.username if obj.approved_by else None

    def validate_password(self, value):
        validate_password(value)
        return value

    def update(self, instance, validated_data):
        # Never allow the stored credential to be rewritten post-submission.
        validated_data.pop('password', None)
        return super().update(instance, validated_data)


class ApprovalRequestSerializer(serializers.ModelSerializer):
    requested_by_name = serializers.SerializerMethodField()
    reviewed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = ApprovalRequest
        fields = (
            'id', 'action', 'entity_type', 'entity_id', 'entity_name', 'message',
            'pending_changes', 'status', 'review_note', 'requested_by',
            'requested_by_name', 'reviewed_by', 'reviewed_by_name',
            'created_at', 'reviewed_at',
        )
        read_only_fields = (
            'status', 'requested_by', 'reviewed_by', 'created_at', 'reviewed_at',
            'review_note',
        )

    def get_requested_by_name(self, obj):
        return obj.requested_by.username if obj.requested_by else None

    def get_reviewed_by_name(self, obj):
        return obj.reviewed_by.username if obj.reviewed_by else None

    def validate(self, attrs):
        """
        The requester must be able to SEE the target before naming it.

        Checking company alone was not enough: an employee cannot see a
        colleague's record, but could still reference it by id, because the
        target was resolved directly rather than through the scoped queryset.
        Resolving through `scope_queryset` means an id the requester has no
        visibility of is indistinguishable from one that does not exist.
        """
        from .permissions import scope_queryset
        from .services import ENTITY_MODELS

        request = self.context['request']
        entity_type = attrs.get('entity_type')
        entity_id = attrs.get('entity_id')

        model = ENTITY_MODELS.get(entity_type)
        if model is None:
            raise serializers.ValidationError(
                {'entity_type': f'"{entity_type}" records cannot be requested.'}
            )
        obj = scope_queryset(
            model.objects.all(), request.user, entity_type,
        ).filter(pk=entity_id).first()
        if obj is None:
            raise serializers.ValidationError({'entity_id': 'That record does not exist.'})

        attrs['entity_name'] = str(obj)[:255]
        # Stamp the branch from the TARGET, not the requester, so the request
        # lands in the queue of the manager who actually controls the record.
        attrs['_target_branch_id'] = getattr(obj, 'branch_id', None)
        return attrs


# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKeySerializer(serializers.ModelSerializer):
    """Read shape. Never includes the hash; the plaintext exists only in the create response."""

    is_valid = serializers.BooleanField(read_only=True)
    user_name = serializers.CharField(source='user.username', read_only=True)

    class Meta:
        model = ApiKey
        fields = (
            'id', 'user', 'user_name', 'name', 'prefix', 'created_at', 'last_used_at',
            'expires_at', 'revoked_at', 'is_valid',
        )
        read_only_fields = fields


class ApiKeyCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate_expires_at(self, value):
        from django.utils import timezone
        if value is not None and value <= timezone.now():
            raise serializers.ValidationError('Expiry must be in the future.')
        return value
