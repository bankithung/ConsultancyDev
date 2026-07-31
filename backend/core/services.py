"""
Domain services: operations that span models, kept out of the view layer.
"""

import hashlib
import logging
import os
import uuid
from decimal import Decimal, ROUND_HALF_UP

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .fields import decrypt_bytes, encrypt_bytes
from .models import (
    Branch, Company, Document, Enquiry, Enrollment, FollowUp, Installment,
    Payment, Plan, Registration, RecordTransfer, Role, Subscription, Task,
    User, VisaTracking,
)

logger = logging.getLogger('core')

# The only models an approval request or transfer may target. An allowlist,
# not a lookup by arbitrary client string.
ENTITY_MODELS = {
    'enquiry': Enquiry,
    'registration': Registration,
    'enrollment': Enrollment,
    'payment': Payment,
    'document': Document,
    'task': Task,
    'follow_up': FollowUp,
    'visa_tracking': VisaTracking,
}

TRANSFERABLE = {
    'enquiry', 'registration', 'enrollment', 'document', 'task',
    'follow_up', 'visa_tracking',
}


def resolve_entity(entity_type, entity_id):
    """Return the object, or None. Never raises on an unknown type."""
    model = ENTITY_MODELS.get(entity_type)
    if model is None:
        return None
    return model.objects.filter(pk=entity_id).first()


def next_reference_number(model, company_id, field, prefix):
    """
    Allocate the next per-company reference, e.g. REG-2026-004.

    These fields are required and uniquely constrained per company, but nothing
    generated them — the client was expected to invent one, so every create
    that omitted it failed validation. Making them server-assigned removes both
    the 400 and the possibility of two branches choosing the same number.

    Called inside the caller's transaction with a row lock on the company, so
    two simultaneous creates cannot allocate the same value. Falls back to a
    uuid suffix if the company row is missing (dev-admin edge case).
    """
    from django.db.models import Max

    if not company_id:
        return f'{prefix}-{uuid.uuid4().hex[:10].upper()}'

    year = timezone.now().year
    # Lock the company row so concurrent creates serialise on it.
    Company.objects.select_for_update().filter(pk=company_id).first()

    existing = model.objects.filter(
        company_id=company_id, **{f'{field}__startswith': f'{prefix}-{year}-'},
    ).aggregate(top=Max(field))['top']

    sequence = 1
    if existing:
        try:
            sequence = int(str(existing).rsplit('-', 1)[-1]) + 1
        except (ValueError, IndexError):
            sequence = model.objects.filter(company_id=company_id).count() + 1
    return f'{prefix}-{year}-{sequence:03d}'


def revoke_all_tokens(user):
    """
    Blacklist every outstanding refresh token for a user.

    Identity claims (role/company/branch) are stamped onto the refresh token
    and copied forward by rotation without re-reading the user, so a demoted
    admin would otherwise keep admin-level UI routing for the whole
    REFRESH_TOKEN_LIFETIME — up to a week. The server still refused their
    requests, but "revoke this person's access" has to visibly take effect
    when it is done, not a week later.

    Called whenever role, branch, company or active status changes.
    """
    from rest_framework_simplejwt.token_blacklist.models import (
        BlacklistedToken, OutstandingToken,
    )

    revoked = 0
    for token in OutstandingToken.objects.filter(user=user):
        _, created = BlacklistedToken.objects.get_or_create(token=token)
        revoked += int(created)
    if revoked:
        logger.info('Revoked %s outstanding token(s) for user %s', revoked, user.pk)
    return revoked


# ---------------------------------------------------------------- provisioning

DEFAULT_PLAN_SLUG = 'starter'


def ensure_default_plans():
    """Idempotently create the built-in plans."""
    defaults = [
        ('Starter', 'starter', 0, 1, 5, 0),
        ('Growth', 'growth', 2999, 5, 25, 1),
        ('Scale', 'scale', 7999, 0, 0, 2),
    ]
    for name, slug, price, branches, users, order in defaults:
        Plan.objects.get_or_create(
            slug=slug,
            defaults={
                'name': name, 'price_monthly': price, 'max_branches': branches,
                'max_users': users, 'sort_order': order,
            },
        )


@transaction.atomic
def provision_company(name, plan=None, trial_days=14, **company_fields):
    """
    Create a company with its first branch and a trialing subscription.

    Every company gets a default branch so that records created before any
    branch is configured still have somewhere to live.
    """
    company = Company.objects.create(name=name, **company_fields)
    branch = Branch.objects.create(
        company=company, name='Head Office', code='HO', is_default=True,
    )
    if plan is None:
        ensure_default_plans()
        plan = Plan.objects.filter(slug=DEFAULT_PLAN_SLUG).first()
    if plan:
        Subscription.objects.create(
            company=company,
            plan=plan,
            status=Subscription.Status.TRIALING,
            trial_ends_at=timezone.now() + timezone.timedelta(days=trial_days),
        )
    return company, branch


def default_branch_for(company):
    return (
        Branch.objects.filter(company=company, is_default=True).first()
        or Branch.objects.filter(company=company).first()
    )


# ------------------------------------------------------------ subscription caps

def check_user_quota(company):
    """
    Raise if adding one more user would exceed the plan.

    Counts `is_active_employee`, which is the field `set_active` toggles and
    the field IsAuthenticatedAndActive enforces. Counting Django's `is_active`
    instead meant deactivating staff never freed a seat, so a company that
    onboarded and offboarded hit a permanent ceiling only fixable in the DB.
    """
    subscription = getattr(company, 'subscription', None)
    if not subscription:
        return
    current = User.objects.filter(
        company=company, is_active=True, is_active_employee=True,
    ).count()
    if not subscription.plan.allows_users(current + 1):
        raise ValidationError(
            f'Your {subscription.plan.name} plan allows {subscription.plan.max_users} '
            f'users. Upgrade to add more.'
        )


def check_branch_quota(company):
    subscription = getattr(company, 'subscription', None)
    if not subscription:
        return
    current = Branch.objects.filter(company=company, is_active=True).count()
    if not subscription.plan.allows_branches(current + 1):
        raise ValidationError(
            f'Your {subscription.plan.name} plan allows {subscription.plan.max_branches} '
            f'branches. Upgrade to add more.'
        )


# ------------------------------------------------------------------- transfers

@transaction.atomic
def create_transfer(*, actor, entity_type, entity_id, to_user, note=''):
    """
    Hand custody of a record to another user.

    Managers and admins transfer immediately; peer-to-peer transfers between
    employees require the recipient to accept, so nobody can silently push
    work onto a colleague.
    """
    if entity_type not in TRANSFERABLE:
        raise ValidationError(f"'{entity_type}' records cannot be transferred.")

    obj = resolve_entity(entity_type, entity_id)
    if obj is None:
        raise ValidationError('That record does not exist.')

    # Authorise the actor against the SUBJECT of the transfer, not just its
    # company.
    #
    # Checking company alone left a second route to cross-branch theft: a
    # branch manager could transfer a record out of a branch they do not
    # control to one of their own staff, and because apply_transfer rewrites
    # branch_id to follow the recipient, the record moved into their scope.
    # Repeated, that drains any branch in the company. The recipient was
    # validated (validate_to_user); the subject was not.
    from .permissions import can_write_object

    if not can_write_object(actor, obj, entity_type):
        # Same message as "not found": an actor who cannot see the record
        # should not be able to probe for its existence.
        raise ValidationError('That record does not exist.')

    immediate = actor.is_dev_admin or actor.role in (
        Role.COMPANY_ADMIN, Role.HEAD_MANAGER, Role.BRANCH_MANAGER,
    )

    transfer = RecordTransfer.objects.create(
        company_id=getattr(obj, 'company_id', None) or actor.company_id,
        branch_id=getattr(obj, 'branch_id', None),
        entity_type=entity_type,
        entity_id=entity_id,
        entity_label=str(obj)[:255],
        from_user=actor,
        to_user=to_user,
        note=note,
        requires_acceptance=not immediate,
        status=RecordTransfer.Status.PENDING,
    )
    if immediate:
        apply_transfer(transfer)
    return transfer


@transaction.atomic
def apply_transfer(transfer):
    """Move ownership and, when the recipient sits elsewhere, the branch too."""
    obj = resolve_entity(transfer.entity_type, transfer.entity_id)
    if obj is None:
        transfer.status = RecordTransfer.Status.CANCELLED
        transfer.resolved_at = timezone.now()
        transfer.save(update_fields=['status', 'resolved_at'])
        return transfer

    obj.owner = transfer.to_user
    update_fields = ['owner']
    # Follow the record to the recipient's branch so branch-scoped managers
    # keep seeing a consistent picture.
    if transfer.to_user.branch_id and getattr(obj, 'branch_id', None) != transfer.to_user.branch_id:
        obj.branch_id = transfer.to_user.branch_id
        update_fields.append('branch')
    if hasattr(obj, 'assigned_to_id'):
        obj.assigned_to = transfer.to_user
        update_fields.append('assigned_to')
    obj.save(update_fields=update_fields + ['updated_at'] if hasattr(obj, 'updated_at') else update_fields)

    transfer.status = RecordTransfer.Status.ACCEPTED
    transfer.resolved_at = timezone.now()
    transfer.save(update_fields=['status', 'resolved_at'])
    logger.info(
        'Transfer %s applied: %s#%s -> user %s',
        transfer.pk, transfer.entity_type, transfer.entity_id, transfer.to_user_id,
    )
    return transfer


# ------------------------------------------------------------------- documents

def _document_key(name):
    return f'{uuid.uuid4().hex}_{os.path.basename(name)[:80]}.enc'


def validate_upload(uploaded):
    ext = os.path.splitext(uploaded.name)[1].lstrip('.').lower()
    if ext not in settings.ALLOWED_DOCUMENT_EXTENSIONS:
        raise ValidationError(
            f'"{ext or "unknown"}" files are not accepted. Allowed: '
            f'{", ".join(settings.ALLOWED_DOCUMENT_EXTENSIONS)}.'
        )
    if uploaded.size > settings.MAX_DOCUMENT_SIZE_BYTES:
        limit_mb = settings.MAX_DOCUMENT_SIZE_BYTES // (1024 * 1024)
        raise ValidationError(f'File is too large. Maximum size is {limit_mb} MB.')
    return ext


def store_document(document, uploaded):
    """
    Encrypt the upload and write it outside any web-served directory.

    Files are never exposed through MEDIA_URL; they are streamed back by an
    authenticated view that re-checks the caller's scope. The old nginx config
    aliased /media/ publicly, so a real FileField would have made every
    passport scan readable at a guessable URL.
    """
    validate_upload(uploaded)

    raw = uploaded.read()
    checksum = hashlib.sha256(raw).hexdigest()
    ciphertext = encrypt_bytes(raw)

    directory = settings.PRIVATE_MEDIA_ROOT / timezone.now().strftime('%Y/%m')
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / _document_key(uploaded.name)
    path.write_bytes(ciphertext)

    document.file_name = os.path.basename(uploaded.name)[:255]
    document.file.name = str(path.relative_to(settings.PRIVATE_MEDIA_ROOT)).replace('\\', '/')
    document.file_size = len(raw)
    document.content_type = getattr(uploaded, 'content_type', '') or ''
    document.checksum = checksum
    document.is_encrypted = True
    return document


def read_document(document):
    """Return the decrypted bytes, or None if the file is missing."""
    if not document.file or not document.file.name:
        return None
    path = settings.PRIVATE_MEDIA_ROOT / document.file.name
    if not path.exists():
        logger.warning('Document %s missing on disk at %s', document.pk, path)
        return None
    data = path.read_bytes()
    if not document.is_encrypted:
        return data
    try:
        return decrypt_bytes(data)
    except Exception:
        logger.error('Failed to decrypt document %s', document.pk, exc_info=True)
        return None


def delete_document_file(document):
    if document.file and document.file.name:
        delete_document_file_by_name(document.file.name)


def delete_document_file_by_name(name):
    """Remove a stored blob by its relative name, e.g. when replacing a file."""
    if not name:
        return
    path = settings.PRIVATE_MEDIA_ROOT / name
    # Refuse to follow a name that escapes the private root.
    try:
        path.resolve().relative_to(settings.PRIVATE_MEDIA_ROOT.resolve())
    except ValueError:
        logger.warning('Refusing to delete out-of-root document path %r', name)
        return
    if path.exists():
        path.unlink()


# ---------------------------------------------------------------- installments

def build_installments(enrollment, count, amount=None):
    """
    Split the balance into `count` instalments that actually sum to the total.

    The previous implementation divided and dropped the remainder, so a
    1000/3 split produced three 333.33 rows totalling 999.99.
    """
    if not count or count < 1:
        return []

    total = Decimal(enrollment.total_fees)
    if amount:
        per = Decimal(amount).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    else:
        per = (total / count).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)

    rows, allocated = [], Decimal('0.00')
    start = enrollment.start_date or timezone.now().date()
    for i in range(1, count + 1):
        value = per if i < count else (total - allocated)
        allocated += value
        rows.append(Installment(
            enrollment=enrollment,
            company_id=enrollment.company_id,
            branch_id=enrollment.branch_id,
            created_by_id=enrollment.created_by_id,
            owner_id=enrollment.owner_id,
            number=i,
            # Step whole months rather than fixed 30-day blocks, which drifted
            # roughly five days off the anniversary over a year.
            due_date=_add_months(start, i),
            amount=value,
            status='Pending',
        ))
    return Installment.objects.bulk_create(rows)


def _add_months(date, months):
    month = date.month - 1 + months
    year = date.year + month // 12
    month = month % 12 + 1
    day = min(date.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
                         else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date.replace(year=year, month=month, day=day)
