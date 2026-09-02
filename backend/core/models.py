"""
Domain models for Consultancy Dev.

Tenancy model
-------------
A Company owns Branches; every operational record belongs to exactly one
Company and (usually) one Branch. Previously tenancy was a free-text
`company_id` string with no database constraint, which allowed two spellings of
the same company name to silently become two tenants. That column is preserved
as `legacy_company_id` purely so the data migration can map it onto real
Company rows, and is dropped afterwards.

Visibility hierarchy
--------------------
    DEV_ADMIN       platform operator, sees everything
    COMPANY_ADMIN   everything inside their Company
    HEAD_MANAGER    the branches of the managers assigned to them
    BRANCH_MANAGER  their own Branch
    EMPLOYEE        records they own, plus records transferred to them

The rules are enforced in core/permissions.py; the fields that make them
expressible live here.
"""

from django.conf import settings as django_settings
from django.contrib.auth.models import AbstractUser
from django.core.validators import MinValueValidator
from django.db import models
from django.utils import timezone
from django.utils.text import slugify

from .fields import EncryptedDateField, EncryptedTextField, blind_index


# ===========================================================================
#  Tenancy
# ===========================================================================

class Company(models.Model):
    name = models.CharField(max_length=200, unique=True)
    slug = models.SlugField(max_length=120, unique=True)
    email = models.EmailField(blank=True, default='')
    phone = models.CharField(max_length=30, blank=True, default='')
    address = models.TextField(blank=True, default='')
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = 'companies'
        ordering = ['name']

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = self._unique_slug(self.name)
        super().save(*args, **kwargs)

    @classmethod
    def _unique_slug(cls, name):
        """
        Collision-safe slug.

        The old implementation slugified the name and stopped, so "IHT Dimapur"
        and "IHT-Dimapur" both produced `iht_dimapur` and merged two tenants.
        """
        base = slugify(name) or 'company'
        slug, n = base, 2
        while cls.objects.filter(slug=slug).exists():
            slug = f'{base}-{n}'
            n += 1
        return slug

    @property
    def active_subscription(self):
        return getattr(self, 'subscription', None)


class Branch(models.Model):
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='branches')
    name = models.CharField(max_length=150)
    code = models.CharField(max_length=30, blank=True, default='')
    city = models.CharField(max_length=100, blank=True, default='')
    address = models.TextField(blank=True, default='')
    phone = models.CharField(max_length=30, blank=True, default='')
    is_active = models.BooleanField(default=True)
    is_default = models.BooleanField(
        default=False,
        help_text='Receives records created before branches existed.',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = 'branches'
        ordering = ['company__name', 'name']
        constraints = [
            models.UniqueConstraint(fields=['company', 'name'], name='uniq_branch_name_per_company'),
            models.UniqueConstraint(
                fields=['company', 'code'], name='uniq_branch_code_per_company',
                condition=models.Q(code__gt=''),
            ),
        ]
        indexes = [models.Index(fields=['company', 'is_active'])]

    def __str__(self):
        return f'{self.name} ({self.company.name})'


# ===========================================================================
#  Billing
# ===========================================================================

class Plan(models.Model):
    name = models.CharField(max_length=80, unique=True)
    slug = models.SlugField(max_length=60, unique=True)
    price_monthly = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    currency = models.CharField(max_length=3, default='INR')
    # 0 means unlimited.
    max_branches = models.PositiveIntegerField(default=1)
    max_users = models.PositiveIntegerField(default=5)
    features = models.JSONField(default=dict, blank=True)
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['sort_order', 'price_monthly']

    def __str__(self):
        return self.name

    # Subscriptions removed: every plan is free and unlimited, so the seat and
    # branch caps always pass. The max_* fields stay only so existing rows,
    # serializers and migrations keep loading unchanged.
    def allows_branches(self, count):
        return True

    def allows_users(self, count):
        return True


class Subscription(models.Model):
    class Status(models.TextChoices):
        TRIALING = 'TRIALING', 'Trialing'
        ACTIVE = 'ACTIVE', 'Active'
        PAST_DUE = 'PAST_DUE', 'Past due'
        CANCELLED = 'CANCELLED', 'Cancelled'
        EXPIRED = 'EXPIRED', 'Expired'

    company = models.OneToOneField(Company, on_delete=models.CASCADE, related_name='subscription')
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name='subscriptions')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.TRIALING)
    trial_ends_at = models.DateTimeField(null=True, blank=True)
    current_period_start = models.DateTimeField(default=timezone.now)
    current_period_end = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    external_reference = models.CharField(max_length=120, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=['status'])]

    def __str__(self):
        return f'{self.company.name} - {self.plan.name} ({self.status})'

    @property
    def is_usable(self):
        """
        Always True. Subscriptions no longer gate anything -- every tenant has
        unlimited access for unlimited time, whatever the status or trial
        dates say. Kept as a property so existing callers keep working.
        """
        return True

    @property
    def days_remaining(self):
        end = self.trial_ends_at if self.status == self.Status.TRIALING else self.current_period_end
        if not end:
            return None
        return max(0, (end - timezone.now()).days)


# ===========================================================================
#  Users and hierarchy
# ===========================================================================

class Role(models.TextChoices):
    DEV_ADMIN = 'DEV_ADMIN', 'Dev Admin'
    COMPANY_ADMIN = 'COMPANY_ADMIN', 'Company Admin'
    HEAD_MANAGER = 'HEAD_MANAGER', 'Head Manager'
    BRANCH_MANAGER = 'BRANCH_MANAGER', 'Branch Manager'
    EMPLOYEE = 'EMPLOYEE', 'Employee'


class Capability(models.TextChoices):
    """
    The vocabulary of things a ROLE may be permitted to do.

    Deliberately identical, value for value, to the `CAN` map in
    `consultancy-dev/components/rbac/roles.ts`. The frontend uses that map to
    decide which controls to render; this enum is what the server actually
    enforces. Two spellings of one concept is how a UI ends up offering a
    button that always 403s, so the values are the shared contract — the
    permissions screen renders whatever this enum contains.

    Permissions are granted to a role, never to an individual: there is no
    per-user override anywhere in this system, by design. "This one employee
    can also approve refunds" is a role, and making it one keeps the answer to
    "who can approve a refund?" answerable without reading every user row.

    The per-role DEFAULTS and the resolution rules live in core/capabilities.py.
    """

    MANAGE_COMPANIES = 'manageCompanies', 'Manage companies'
    MANAGE_BRANCHES = 'manageBranches', 'Manage branches'
    MANAGE_USERS = 'manageUsers', 'Manage staff accounts'
    VIEW_ANALYTICS = 'viewAnalytics', 'View analytics'
    VIEW_EARNINGS = 'viewEarnings', 'View earnings and commissions'
    MANAGE_COMMISSIONS = 'manageCommissions', 'Manage commissions and agents'
    MANAGE_SETTINGS = 'manageSettings', 'Manage company settings and permissions'
    REVIEW_APPROVALS = 'reviewApprovals', 'Review approval requests'
    MANAGE_COUNSELORS = 'manageCounselors', 'View counselor performance'
    MANAGE_REFUNDS = 'manageRefunds', 'File and approve refunds'
    DELETE_RECORDS = 'deleteRecords', 'Delete records directly'


class User(AbstractUser):
    # Kept for backwards compatibility with the old string tenancy; the FK
    # below is authoritative. Dropped once the data migration has run.
    ROLE_CHOICES = Role.choices

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.EMPLOYEE, db_index=True)
    legacy_company_id = models.CharField(max_length=100, blank=True, null=True)

    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, related_name='users',
        null=True, blank=True,
        help_text='Null only for DEV_ADMIN (platform operators).',
    )
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, related_name='users',
        null=True, blank=True,
        help_text='Required for BRANCH_MANAGER and EMPLOYEE.',
    )
    # A Head Manager oversees a chosen set of branch managers; the admin
    # configures this. Their data scope is the union of those managers' branches.
    managed_managers = models.ManyToManyField(
        'self', symmetrical=False, related_name='head_managers', blank=True,
        limit_choices_to={'role': Role.BRANCH_MANAGER},
    )
    phone = models.CharField(max_length=30, blank=True, default='')
    avatar = models.URLField(blank=True, null=True)
    is_active_employee = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True, null=True)

    class Meta:
        # Deterministic ordering is required under pagination: without it
        # /api/users/?page=2 can repeat or skip rows, and Django emits
        # UnorderedObjectListWarning.
        ordering = ['username']
        indexes = [
            models.Index(fields=['company', 'role']),
            models.Index(fields=['branch']),
        ]

    def __str__(self):
        return f'{self.username} ({self.get_role_display()})'

    # -- role predicates ---------------------------------------------------
    @property
    def is_dev_admin(self):
        return self.role == Role.DEV_ADMIN or self.is_superuser

    @property
    def is_company_admin(self):
        return self.role == Role.COMPANY_ADMIN

    @property
    def is_head_manager(self):
        return self.role == Role.HEAD_MANAGER

    @property
    def is_branch_manager(self):
        return self.role == Role.BRANCH_MANAGER

    @property
    def is_employee(self):
        return self.role == Role.EMPLOYEE

    @property
    def can_manage_users(self):
        return self.is_dev_admin or self.is_company_admin

    def visible_branch_ids(self):
        """
        Branch ids this user may see. Empty list means "not branch-limited"
        for company-wide roles; callers must check the role first.
        """
        if self.is_head_manager:
            return list(
                Branch.objects.filter(
                    users__in=self.managed_managers.all()
                ).values_list('id', flat=True).distinct()
            )
        if self.is_branch_manager or self.is_employee:
            return [self.branch_id] if self.branch_id else []
        return []


class RolePermission(models.Model):
    """
    A company's override of ONE cell of the role x capability grid.

    RESOLUTION RULE — read this before changing anything here:

        a row exists for (company, role, capability)  ->  `allowed` decides
        NO row exists                                 ->  the BUILT-IN DEFAULT
                                                          for that role decides

    A missing row means "fall back to the default". It does NOT mean denied and
    it does NOT mean allowed. Both of the obvious alternatives are outages:
    treating an empty table as "deny everything" locks every tenant out the
    moment this migration is applied, and treating it as "allow everything"
    fails open and hands every employee the admin surface. An empty table
    therefore reproduces the previous hardcoded behaviour EXACTLY, which is what
    makes deploying this a no-op until an admin actually changes something.

    Two further rules, both enforced in core/capabilities.py rather than here:

      * PROTECTED capabilities have a floor role and cannot be held below it,
        no matter what a row says. The floor is applied when the matrix is
        RESOLVED, not only when it is written, so a row inserted by hand in the
        database or the Django admin still cannot escalate anyone.
      * Rows for DEV_ADMIN are ignored. The platform operator's access is not
        part of a tenant's configurable surface — otherwise a customer could
        lock their own vendor out of their instance.

    Scoped to a company: two tenants configure their roles independently, and
    the resolved matrix is cached PER COMPANY for the same reason.
    """

    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, related_name='role_permissions',
    )
    role = models.CharField(max_length=20, choices=Role.choices)
    capability = models.CharField(max_length=40, choices=Capability.choices)
    allowed = models.BooleanField(
        help_text='Explicit grant or denial. Delete the row to return to the default.',
    )
    # Who last changed it. SET_NULL rather than CASCADE: deleting the admin who
    # granted a capability must not silently revoke it.
    updated_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='role_permission_changes',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['company_id', 'role', 'capability']
        constraints = [
            models.UniqueConstraint(
                fields=['company', 'role', 'capability'],
                name='uniq_role_permission_per_company',
            ),
        ]
        indexes = [models.Index(fields=['company', 'role'])]

    def __str__(self):
        state = 'allow' if self.allowed else 'deny'
        return f'{self.company_id}/{self.role}/{self.capability}={state}'


# ===========================================================================
#  Shared base for every tenant-owned record
# ===========================================================================

class TenantScopedModel(models.Model):
    """
    Every operational record carries its tenant, its branch, who created it and
    who currently owns it. Ownership is separate from authorship precisely so a
    record can be transferred without rewriting history.
    """

    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, related_name='%(class)ss',
        null=True, blank=True,
    )
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, related_name='%(class)ss',
        null=True, blank=True,
    )
    created_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='created_%(class)ss',
    )
    owner = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='owned_%(class)ss',
        help_text='Current custodian. Changes when the record is transferred.',
    )
    legacy_company_id = models.CharField(max_length=100, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        indexes = [
            models.Index(fields=['company', 'branch']),
            models.Index(fields=['owner']),
            models.Index(fields=['created_at']),
        ]


# ===========================================================================
#  CRM records
# ===========================================================================

class Enquiry(TenantScopedModel):
    class Status(models.TextChoices):
        NEW = 'New', 'New'
        CONTACTED = 'Contacted', 'Contacted'
        CONVERTED = 'Converted', 'Converted'
        CLOSED = 'Closed', 'Closed'

    date = models.DateTimeField(auto_now_add=True)
    school_name = models.CharField(max_length=255)
    stream = models.CharField(max_length=50)
    candidate_name = models.CharField(max_length=255, blank=True, default='')
    course_interested = models.CharField(max_length=255)
    mobile = models.CharField(max_length=20)
    email = models.EmailField()
    father_name = models.CharField(max_length=255)
    mother_name = models.CharField(max_length=255)
    father_occupation = models.CharField(max_length=255, blank=True, default='')
    mother_occupation = models.CharField(max_length=255, blank=True, default='')
    father_mobile = models.CharField(max_length=20, blank=True, default='')
    mother_mobile = models.CharField(max_length=20, blank=True, default='')
    permanent_address = models.TextField()
    preferred_locations = models.JSONField(default=list, blank=True)
    other_location = models.CharField(max_length=150, blank=True, default='')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.NEW, db_index=True)

    # ---------------------------------------------------------------- profile
    #
    # The enquiry form has always collected these; the table never had columns
    # for them, so ~30 fields per enquiry were silently discarded at the API
    # boundary. For a medical/engineering admissions consultancy these are the
    # fields that decide eligibility — NEET scores and PCB/PCM percentages are
    # the whole basis of a counselling recommendation.
    gender = models.CharField(max_length=20, blank=True, default='')
    # Encrypted at rest, consistent with Registration.date_of_birth.
    date_of_birth = EncryptedDateField(null=True, blank=True)
    caste = models.CharField(max_length=50, blank=True, default='')
    religion = models.CharField(max_length=50, blank=True, default='')
    family_place = models.CharField(max_length=120, blank=True, default='')
    family_state = models.CharField(max_length=120, blank=True, default='')

    # Class 12 / current school
    school_board = models.CharField(max_length=100, blank=True, default='')
    school_place = models.CharField(max_length=120, blank=True, default='')
    school_state = models.CharField(max_length=120, blank=True, default='')
    class12_passing_year = models.CharField(max_length=10, blank=True, default='')
    class12_percentage = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        validators=[MinValueValidator(0)],
    )

    # Class 10
    class10_school_name = models.CharField(max_length=255, blank=True, default='')
    class10_board = models.CharField(max_length=100, blank=True, default='')
    class10_passing_year = models.CharField(max_length=10, blank=True, default='')
    class10_place = models.CharField(max_length=120, blank=True, default='')
    class10_state = models.CharField(max_length=120, blank=True, default='')
    class10_percentage = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True,
        validators=[MinValueValidator(0)],
    )

    # Subject marks and the derived stream percentages used for eligibility.
    physics_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    chemistry_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    biology_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    maths_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    pcb_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    pcm_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)

    # Entrance exam history
    previous_neet_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    present_neet_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)

    # Gaps in education — material to admission eligibility.
    gap_year = models.BooleanField(default=False)
    gap_year_from = models.PositiveIntegerField(null=True, blank=True)
    gap_year_to = models.PositiveIntegerField(null=True, blank=True)
    college_dropout = models.BooleanField(default=False)

    payment_amount = models.DecimalField(
        max_digits=12, decimal_places=2, null=True, blank=True,
        validators=[MinValueValidator(0)],
    )

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']
        verbose_name_plural = 'enquiries'
        indexes = TenantScopedModel.Meta.indexes + [
            models.Index(fields=['company', 'status']),
        ]

    def __str__(self):
        return f'{self.candidate_name or self.school_name} - {self.course_interested}'


class Registration(TenantScopedModel):
    registration_no = models.CharField(max_length=50)
    student_name = models.CharField(max_length=255, db_index=True)
    mobile = models.CharField(max_length=20)
    email = models.EmailField()
    # Encrypted at rest: never filtered or sorted on.
    date_of_birth = EncryptedDateField(null=True, blank=True)
    father_name = models.CharField(max_length=255, blank=True, default='')
    mother_name = models.CharField(max_length=255, blank=True, default='')
    permanent_address = models.TextField(blank=True, default='')
    registration_date = models.DateTimeField(auto_now_add=True)
    needs_loan = models.BooleanField(default=False)
    payment_status = models.CharField(max_length=20, default='Pending', db_index=True)
    payment_method = models.CharField(max_length=50, default='Cash')
    registration_fee = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(0)],
    )
    preferences = models.JSONField(default=list, blank=True)
    enquiry = models.ForeignKey(
        Enquiry, on_delete=models.SET_NULL, null=True, blank=True, related_name='registrations',
    )

    # ---------------------------------------------------------------- profile
    #
    # Mirrors the Enquiry profile so a conversion carries the student's details
    # forward instead of losing them. Without these columns the registration
    # form's gender/caste/religion/schooling/marks were being written into the
    # append-only remarks log as free text — recorded, but not filterable,
    # reportable or correctable, and never read back into the form on edit.
    gender = models.CharField(max_length=20, blank=True, default='')
    caste = models.CharField(max_length=50, blank=True, default='')
    religion = models.CharField(max_length=50, blank=True, default='')
    father_occupation = models.CharField(max_length=255, blank=True, default='')
    mother_occupation = models.CharField(max_length=255, blank=True, default='')
    father_mobile = models.CharField(max_length=20, blank=True, default='')
    mother_mobile = models.CharField(max_length=20, blank=True, default='')
    family_place = models.CharField(max_length=120, blank=True, default='')
    family_state = models.CharField(max_length=120, blank=True, default='')

    stream = models.CharField(max_length=50, blank=True, default='')
    school_name = models.CharField(max_length=255, blank=True, default='')
    school_board = models.CharField(max_length=100, blank=True, default='')
    school_place = models.CharField(max_length=120, blank=True, default='')
    school_state = models.CharField(max_length=120, blank=True, default='')
    class12_passing_year = models.CharField(max_length=10, blank=True, default='')
    class12_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    class10_school_name = models.CharField(max_length=255, blank=True, default='')
    class10_board = models.CharField(max_length=100, blank=True, default='')
    class10_passing_year = models.CharField(max_length=10, blank=True, default='')
    class10_place = models.CharField(max_length=120, blank=True, default='')
    class10_state = models.CharField(max_length=120, blank=True, default='')
    class10_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)

    physics_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    chemistry_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    biology_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    maths_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    pcb_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    pcm_percentage = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    previous_neet_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    present_neet_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)

    gap_year = models.BooleanField(default=False)
    gap_year_from = models.PositiveIntegerField(null=True, blank=True)
    gap_year_to = models.PositiveIntegerField(null=True, blank=True)
    college_dropout = models.BooleanField(default=False)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']
        constraints = [
            # Previously unique globally, so one company could permanently
            # block another from using an obvious number like REG-001.
            models.UniqueConstraint(
                fields=['company', 'registration_no'], name='uniq_registration_no_per_company',
            ),
        ]
        indexes = TenantScopedModel.Meta.indexes + [
            models.Index(fields=['company', 'payment_status']),
        ]

    def __str__(self):
        return f'{self.registration_no} - {self.student_name}'


class Enrollment(TenantScopedModel):
    enrollment_no = models.CharField(max_length=50)
    student = models.ForeignKey(Registration, on_delete=models.PROTECT, related_name='enrollments')
    program_name = models.CharField(max_length=255)
    university = models.ForeignKey(
        'University', on_delete=models.SET_NULL, null=True, blank=True, related_name='enrollments',
    )
    university_name = models.CharField(max_length=255, blank=True, default='')
    country = models.CharField(max_length=100, blank=True, default='')
    start_date = models.DateField()
    duration_months = models.PositiveIntegerField()
    total_fees = models.DecimalField(max_digits=12, decimal_places=2, validators=[MinValueValidator(0)])
    commission_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.CharField(max_length=20, default='Active', db_index=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['company', 'enrollment_no'], name='uniq_enrollment_no_per_company',
            ),
        ]

    def __str__(self):
        return f'{self.enrollment_no} - {self.program_name}'


class Installment(TenantScopedModel):
    enrollment = models.ForeignKey(Enrollment, related_name='installments', on_delete=models.CASCADE)
    number = models.PositiveIntegerField()
    due_date = models.DateField()
    amount = models.DecimalField(max_digits=12, decimal_places=2, validators=[MinValueValidator(0)])
    status = models.CharField(max_length=20, default='Pending', db_index=True)
    paid_at = models.DateTimeField(null=True, blank=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['enrollment_id', 'number']
        constraints = [
            models.UniqueConstraint(fields=['enrollment', 'number'], name='uniq_installment_number'),
        ]


class Payment(TenantScopedModel):
    class Status(models.TextChoices):
        PENDING = 'Pending', 'Pending'
        SUCCESS = 'Success', 'Success'
        FAILED = 'Failed', 'Failed'
        REFUNDED = 'Refunded', 'Refunded'

    # Was a bare student_name string, which made reconciliation impossible and
    # forced a name/amount tuple match in the backfill script.
    registration = models.ForeignKey(
        Registration, on_delete=models.PROTECT, null=True, blank=True, related_name='payments',
    )
    enrollment = models.ForeignKey(
        Enrollment, on_delete=models.PROTECT, null=True, blank=True, related_name='payments',
    )
    installment = models.ForeignKey(
        Installment, on_delete=models.SET_NULL, null=True, blank=True, related_name='payments',
    )
    student_name = models.CharField(max_length=255, db_index=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2, validators=[MinValueValidator(0)])
    date = models.DateTimeField(default=timezone.now, db_index=True)
    type = models.CharField(max_length=50, db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    method = models.CharField(max_length=50, default='Cash')
    reference = models.CharField(max_length=120, blank=True, default='')
    # Method-specific detail the flat `reference` cannot hold: cheque number
    # and bank, UPI transaction id, card last-4 and network. Kept as JSON
    # because the shape genuinely differs per method, and promoting each to a
    # column would leave most of them null on most rows.
    metadata = models.JSONField(default=dict, blank=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-date']
        indexes = TenantScopedModel.Meta.indexes + [
            models.Index(fields=['company', 'status', 'date']),
            models.Index(fields=['company', 'type']),
        ]

    def __str__(self):
        return f'{self.student_name} - {self.amount} ({self.status})'


class Document(TenantScopedModel):
    class Status(models.TextChoices):
        IN = 'IN', 'In'
        OUT = 'OUT', 'Out'

    file_name = models.CharField(max_length=255)
    # Real storage. Previously the frontend called an `uploadMock` that posted
    # only the filename, so nothing was ever stored.
    file = models.FileField(upload_to='documents/%Y/%m/', null=True, blank=True)
    file_size = models.PositiveIntegerField(default=0)
    content_type = models.CharField(max_length=120, blank=True, default='')
    checksum = models.CharField(max_length=64, blank=True, default='')
    is_encrypted = models.BooleanField(default=True)
    type = models.CharField(max_length=50, db_index=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.IN)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    student_name = models.CharField(max_length=255, blank=True, default='', db_index=True)
    registration = models.ForeignKey(
        Registration, on_delete=models.CASCADE, null=True, blank=True, related_name='documents',
    )
    # An enquirer has no Registration row yet, so `registration` alone cannot
    # link their documents. Exactly one of the two is set, or neither: a
    # document that belongs to nobody in particular is still a real document.
    enquiry = models.ForeignKey(
        'Enquiry', on_delete=models.CASCADE, null=True, blank=True, related_name='documents',
    )
    expiry_date = models.DateField(blank=True, null=True, db_index=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-uploaded_at']
        indexes = TenantScopedModel.Meta.indexes + [
            models.Index(fields=['company', 'expiry_date']),
        ]

    def __str__(self):
        return self.file_name


class Task(TenantScopedModel):
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default='')
    assigned_to = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='tasks',
    )
    due_date = models.DateTimeField(db_index=True)
    priority = models.CharField(max_length=20, default='Medium')
    status = models.CharField(max_length=20, default='Todo', db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    # Manual ordering within a kanban column. Without it, a board's drag-and-drop
    # can reorder cards on screen but has nowhere to persist the result, so the
    # order resets on reload.
    position = models.PositiveIntegerField(default=0, db_index=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['position', 'due_date']


class Appointment(TenantScopedModel):
    TYPE_CHOICES = (
        ('In-Person', 'In-Person'), ('Video Call', 'Video Call'), ('Phone Call', 'Phone Call'),
    )
    STATUS_CHOICES = (
        ('Scheduled', 'Scheduled'), ('Completed', 'Completed'), ('Cancelled', 'Cancelled'),
    )

    student_name = models.CharField(max_length=255)
    student_email = models.EmailField(blank=True, default='')
    counselor = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='appointments',
    )
    date = models.DateTimeField(db_index=True)
    time = models.TimeField(null=True, blank=True)
    duration = models.PositiveIntegerField(default=60)
    type = models.CharField(max_length=20, choices=TYPE_CHOICES, default='In-Person')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Scheduled', db_index=True)
    notes = models.TextField(blank=True, default='')

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-date']


class University(models.Model):
    """Shared reference catalogue, optionally scoped to one company."""

    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, null=True, blank=True, related_name='universities',
        help_text='Null means a globally shared catalogue entry.',
    )
    name = models.CharField(max_length=255, db_index=True)
    country = models.CharField(max_length=100, db_index=True)
    city = models.CharField(max_length=100, blank=True, default='')
    ranking = models.PositiveIntegerField(null=True, blank=True)
    programs = models.JSONField(default=list, blank=True)
    tuition_fee_min = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    tuition_fee_max = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    admission_deadline = models.CharField(max_length=50, blank=True, default='')
    requirements = models.JSONField(default=list, blank=True)
    rating = models.DecimalField(max_digits=3, decimal_places=2, default=0)
    created_at = models.DateTimeField(auto_now_add=True, null=True)

    class Meta:
        verbose_name_plural = 'universities'
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['company', 'name'], name='uniq_university_per_company'),
        ]

    def __str__(self):
        return self.name


class Template(TenantScopedModel):
    CATEGORY_CHOICES = (('Email', 'Email'), ('SMS', 'SMS'), ('WhatsApp', 'WhatsApp'))

    name = models.CharField(max_length=255)
    template_type = models.CharField(max_length=50, blank=True, default='')
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, default='Email')
    subject = models.CharField(max_length=255, blank=True, default='')
    content = models.TextField()
    variables = models.JSONField(default=list, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['company', 'name'], name='uniq_template_name_per_company'),
        ]


class Notification(models.Model):
    TYPE_CHOICES = (
        ('info', 'Info'), ('success', 'Success'), ('warning', 'Warning'), ('error', 'Error'),
    )

    user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='notifications',
    )
    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, null=True, blank=True, related_name='notifications',
    )
    title = models.CharField(max_length=255)
    message = models.TextField(blank=True, default='')
    type = models.CharField(max_length=20, choices=TYPE_CHOICES, default='info')
    is_read = models.BooleanField(default=False, db_index=True)
    action_url = models.CharField(max_length=255, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['user', 'is_read'])]

    def __str__(self):
        return self.title


class Agent(TenantScopedModel):
    name = models.CharField(max_length=255)
    email = models.EmailField(blank=True, default='')
    phone = models.CharField(max_length=30, blank=True, default='')
    commission_type = models.CharField(max_length=50, default='Percentage')
    commission_value = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    status = models.CharField(max_length=20, default='Active', db_index=True)
    # Derived aggregates, recomputed by signals rather than trusted as stored state.
    total_earned = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    pending_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    students_referred = models.PositiveIntegerField(default=0)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['name']

    def __str__(self):
        return self.name


class Commission(TenantScopedModel):
    STATUS_CHOICES = (('Pending', 'Pending'), ('Paid', 'Paid'))

    agent = models.ForeignKey(
        Agent, on_delete=models.PROTECT, null=True, blank=True, related_name='commissions',
    )
    student = models.ForeignKey(
        Registration, on_delete=models.SET_NULL, null=True, blank=True, related_name='commissions',
    )
    enrollment = models.ForeignKey(
        Enrollment, on_delete=models.SET_NULL, null=True, blank=True, related_name='commissions',
    )
    enrollment_fee = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    commission_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Pending', db_index=True)
    paid_at = models.DateTimeField(null=True, blank=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']


class Refund(TenantScopedModel):
    class Status(models.TextChoices):
        PENDING = 'Pending', 'Pending'
        APPROVED = 'Approved', 'Approved'
        PROCESSED = 'Processed', 'Processed'
        REJECTED = 'Rejected', 'Rejected'

    student = models.ForeignKey(
        Registration, on_delete=models.PROTECT, related_name='refunds',
    )
    payment = models.ForeignKey(
        Payment, on_delete=models.SET_NULL, null=True, blank=True, related_name='refunds',
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2, validators=[MinValueValidator(0)])
    reason = models.TextField(blank=True, default='')
    # Previously a bare CharField with no choices, so the API accepted any
    # string and nothing kept the client's vocabulary honest — the same class
    # of defect that left the approvals queue comparing 'Pending' against a
    # wire value of 'PENDING'.
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True,
    )
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']


class VisaTracking(TenantScopedModel):
    STAGE_CHOICES = (
        ('Documents', 'Documents'), ('Applied', 'Applied'), ('Biometrics', 'Biometrics'),
        ('Interview', 'Interview'), ('Decision', 'Decision'), ('Approved', 'Approved'),
        ('Rejected', 'Rejected'),
    )

    student = models.ForeignKey(
        Registration, on_delete=models.CASCADE, null=True, blank=True, related_name='visa_records',
    )
    student_name = models.CharField(max_length=255, db_index=True)
    # Encrypted at rest, with a blind index for exact lookup.
    passport_no = EncryptedTextField(blank=True, default='')
    passport_no_index = models.CharField(max_length=64, blank=True, default='', db_index=True)
    country = models.CharField(max_length=100, db_index=True)
    visa_type = models.CharField(max_length=100, blank=True, default='')
    applied_date = models.DateField(null=True, blank=True)
    current_stage = models.CharField(max_length=30, choices=STAGE_CHOICES, default='Documents', db_index=True)
    interview_date = models.DateField(null=True, blank=True)
    expected_decision = models.DateField(null=True, blank=True)
    officer = models.CharField(max_length=150, blank=True, default='')
    notes = models.TextField(blank=True, default='')
    status = models.CharField(max_length=30, default='In Progress', db_index=True)

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']
        verbose_name_plural = 'visa tracking'

    def save(self, *args, **kwargs):
        self.passport_no_index = blind_index(self.passport_no) if self.passport_no else ''
        super().save(*args, **kwargs)


class FollowUp(TenantScopedModel):
    class Outcome(models.TextChoices):
        NOT_REACHED = 'Not reached', 'Could not reach'
        INTERESTED = 'Interested', 'Interested'
        THINKING = 'Thinking', 'Still deciding'
        NOT_INTERESTED = 'Not interested', 'Not interested'
        CONVERTED = 'Converted', 'Converted'

    class Likelihood(models.TextChoices):
        HIGH = 'High', 'High'
        MEDIUM = 'Medium', 'Medium'
        LOW = 'Low', 'Low'
        UNKNOWN = 'Unknown', 'Unknown'

    enquiry = models.ForeignKey(
        Enquiry, on_delete=models.CASCADE, related_name='follow_ups',
    )
    # Was a free-text CharField, so follow-ups could not be filtered by user,
    # validated, or transferred.
    assigned_to = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='follow_ups',
    )
    scheduled_for = models.DateTimeField(db_index=True)
    type = models.CharField(max_length=50, default='Call')
    status = models.CharField(max_length=20, default='Pending', db_index=True)
    priority = models.CharField(max_length=20, default='Medium')
    notes = models.TextField(blank=True, default='')
    completed_at = models.DateTimeField(null=True, blank=True)
    # What actually happened on the call, and how likely this lead is to
    # convert. Ported from the kikonsDev build, where counselors recorded both
    # when completing a follow-up.
    outcome_status = models.CharField(
        max_length=20, choices=Outcome.choices, blank=True, default='', db_index=True,
    )
    admission_possibility = models.CharField(
        max_length=10, choices=Likelihood.choices, blank=True, default='',
    )

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['scheduled_for']


# ===========================================================================
#  Onboarding and workflow
# ===========================================================================
#
#  Chat / real-time messaging was removed at the owner's request. It carried
#  three of the audit's critical findings (world-readable message history,
#  forgeable senders, and an unbounded nested serializer) and the WebSocket
#  layer backing it never authenticated successfully. Notifications remain and
#  are delivered by polling.

class SignupRequest(models.Model):
    STATUS_CHOICES = (
        ('Pending', 'Pending'), ('Approved', 'Approved'), ('Rejected', 'Rejected'),
    )

    company_name = models.CharField(max_length=200)
    admin_name = models.CharField(max_length=150)
    email = models.EmailField(unique=True)
    phone = models.CharField(max_length=30, blank=True, default='')
    plan = models.ForeignKey(Plan, on_delete=models.SET_NULL, null=True, blank=True)
    username = models.CharField(max_length=150, unique=True)
    password = models.CharField(max_length=255)
    first_name = models.CharField(max_length=100, blank=True, default='')
    last_name = models.CharField(max_length=100, blank=True, default='')
    requested_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Pending', db_index=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='approved_signups',
    )
    rejection_reason = models.TextField(blank=True, default='')
    created_company = models.ForeignKey(
        Company, on_delete=models.SET_NULL, null=True, blank=True, related_name='signup_requests',
    )

    class Meta:
        ordering = ['-requested_at']

    def __str__(self):
        return f'{self.company_name} ({self.status})'


class ApprovalRequest(models.Model):
    class Action(models.TextChoices):
        DELETE = 'DELETE', 'Delete'
        UPDATE = 'UPDATE', 'Update'

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        APPROVED = 'APPROVED', 'Approved'
        REJECTED = 'REJECTED', 'Rejected'
        FAILED = 'FAILED', 'Failed'

    # Only these may be targeted, and the target is re-checked against the
    # requester's own company at approval time.
    ENTITY_CHOICES = (
        ('enquiry', 'Enquiry'), ('registration', 'Registration'),
        ('enrollment', 'Enrollment'), ('payment', 'Payment'),
        ('document', 'Document'), ('task', 'Task'),
        ('appointment', 'Appointment'), ('follow_up', 'Follow-up'),
    )

    action = models.CharField(max_length=10, choices=Action.choices)
    entity_type = models.CharField(max_length=30, choices=ENTITY_CHOICES)
    entity_id = models.PositiveIntegerField()
    entity_name = models.CharField(max_length=255, blank=True, default='')
    message = models.TextField(blank=True, default='')
    pending_changes = models.JSONField(default=dict, blank=True)
    company = models.ForeignKey(
        Company, on_delete=models.CASCADE, related_name='approval_requests', null=True, blank=True,
    )
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, related_name='approval_requests', null=True, blank=True,
    )
    requested_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='approval_requests',
    )
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    review_note = models.TextField(blank=True, default='')
    reviewed_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='reviewed_requests',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['company', 'status'])]

    def __str__(self):
        return f'{self.action} {self.entity_type}#{self.entity_id} ({self.status})'


class FollowUpComment(TenantScopedModel):
    """
    The discussion thread on a follow-up.

    Ported from the kikonsDev build, where the follow-up detail page carried a
    running conversation between counselor and manager. Append-only for the
    same reason as StudentRemark: it records what was said at the time.
    """

    follow_up = models.ForeignKey(
        FollowUp, on_delete=models.CASCADE, related_name='comments',
    )
    author = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='follow_up_comments',
    )
    comment = models.TextField()

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['created_at']

    def __str__(self):
        return f'{self.follow_up_id}: {self.comment[:40]}'


class StudentRemark(TenantScopedModel):
    """
    A dated, attributed note on a student's file.

    Ported from the kikonsDev build, where the student profile carried a
    running commentary from counselors. Append-only by design: remarks are a
    record of what was believed at the time, so editing one would rewrite
    history rather than correct it.
    """

    registration = models.ForeignKey(
        Registration, on_delete=models.CASCADE, related_name='remarks',
    )
    user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='student_remarks',
    )
    remark = models.TextField()

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.registration_id}: {self.remark[:40]}'


class StudentDocument(TenantScopedModel):
    """
    Custody tracking for a student's ORIGINAL physical documents.

    Distinct from `Document`, which stores uploaded scans. This tracks the
    paper: a consultancy physically holds a passport or a degree certificate
    and is liable for returning it. `current_holder` answers "who has it right
    now", which is the question that matters when a student asks for it back.
    """

    class Status(models.TextChoices):
        RECEIVED = 'Received', 'Received'
        WITH_STAFF = 'With staff', 'With staff'
        SUBMITTED = 'Submitted', 'Submitted to university/embassy'
        RETURNED = 'Returned', 'Returned to student'
        LOST = 'Lost', 'Lost'

    registration = models.ForeignKey(
        Registration, on_delete=models.CASCADE, related_name='student_documents',
    )
    name = models.CharField(max_length=200)
    document_number = models.CharField(max_length=120, blank=True, default='')
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.RECEIVED, db_index=True,
    )
    received_at = models.DateTimeField(default=timezone.now)
    returned_at = models.DateTimeField(null=True, blank=True)
    remarks = models.TextField(blank=True, default='')
    current_holder = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, blank=True, related_name='held_documents',
        help_text='Who physically holds this document right now.',
    )

    class Meta(TenantScopedModel.Meta):
        abstract = False
        ordering = ['-received_at']
        indexes = TenantScopedModel.Meta.indexes + [
            models.Index(fields=['registration', 'status']),
        ]

    def __str__(self):
        return f'{self.name} ({self.status})'


class RecordTransfer(models.Model):
    """
    Hands custody of a record from one user to another.

    Replaces DocumentTransfer, which recorded an intent but changed no
    ownership field (documents had no owner column), so "transferring" a
    document granted the receiver nothing.
    """

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        ACCEPTED = 'ACCEPTED', 'Accepted'
        REJECTED = 'REJECTED', 'Rejected'
        CANCELLED = 'CANCELLED', 'Cancelled'

    ENTITY_CHOICES = (
        ('enquiry', 'Enquiry'), ('registration', 'Registration'),
        ('enrollment', 'Enrollment'), ('document', 'Document'),
        ('task', 'Task'), ('follow_up', 'Follow-up'), ('visa_tracking', 'Visa tracking'),
    )

    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='transfers')
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='transfers',
    )
    entity_type = models.CharField(max_length=30, choices=ENTITY_CHOICES, db_index=True)
    entity_id = models.PositiveIntegerField()
    entity_label = models.CharField(max_length=255, blank=True, default='')
    from_user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='transfers_sent',
    )
    to_user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='transfers_received',
    )
    note = models.TextField(blank=True, default='')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    requires_acceptance = models.BooleanField(
        default=True,
        help_text='Admin and manager transfers may apply immediately.',
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['company', 'status']),
            models.Index(fields=['entity_type', 'entity_id']),
            models.Index(fields=['to_user', 'status']),
        ]

    def __str__(self):
        return f'{self.entity_type}#{self.entity_id}: {self.from_user_id} -> {self.to_user_id}'


# ===========================================================================
#  Personal API keys
# ===========================================================================

class ApiKey(models.Model):
    """
    A long-lived credential that lets a script or an MCP client act as ONE
    user. It carries no permissions of its own: authentication resolves to the
    user, and every authorization decision is then the user's role, company
    and branch exactly as for a JWT session.

    Only the sha256 of the key is stored. `prefix` (the first 12 characters)
    exists so a user can recognise a key in a list without the hash ever being
    shown.
    """

    KEY_PREFIX = 'cdk_'
    KEY_RANDOM_LENGTH = 40

    user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='api_keys',
    )
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=12, db_index=True)
    key_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['user', 'revoked_at'])]

    def __str__(self):
        return f'{self.name} ({self.prefix}...)'

    @staticmethod
    def hash_key(raw):
        import hashlib
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    @classmethod
    def generate_raw(cls):
        import secrets
        alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        body = ''.join(secrets.choice(alphabet) for _ in range(cls.KEY_RANDOM_LENGTH))
        return cls.KEY_PREFIX + body

    @classmethod
    def issue(cls, user, name, expires_at=None):
        """Create a key and return (instance, plaintext). The plaintext is never stored."""
        raw = cls.generate_raw()
        instance = cls.objects.create(
            user=user, name=name, prefix=raw[:12], key_hash=cls.hash_key(raw), expires_at=expires_at,
        )
        return instance, raw

    @property
    def is_valid(self):
        if self.revoked_at is not None:
            return False
        if self.expires_at is not None and self.expires_at <= timezone.now():
            return False
        return True

    def revoke(self):
        if self.revoked_at is None:
            self.revoked_at = timezone.now()
            self.save(update_fields=['revoked_at'])
