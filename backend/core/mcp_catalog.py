"""
Build the MCP catalog: a JSON description of every API resource, field, filter,
action, enum and authorization rule, generated from the code that enforces it.

The MCP server reads the committed `mcp_server/catalog.json`; the test in
core/test_mcp_catalog.py fails when the file no longer matches this builder.
"""

from __future__ import annotations

import datetime as dt

from django.conf import settings
from django_filters import rest_framework as df
from rest_framework import serializers as drf_serializers
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from . import capabilities, services
from .filters import JSONContainsAnyFilter, MultiValueFilter, MultiValueIdFilter
from .models import (
    ApprovalRequest, Appointment, Capability, Commission, Document, Enquiry, FollowUp,
    Notification, Payment, RecordTransfer, Refund, Role, SignupRequest,
    StudentDocument, Subscription, Template, VisaTracking,
)
from .urls import router
from .views import ApprovalRequestViewSet, ScopedModelViewSet

SCHEMA_VERSION = 1

# router prefix -> (plural snake_case, singular snake_case). Every registered
# prefix must be here; the test enforces it.
RESOURCE_NAMES = {
    'companies': ('companies', 'company'),
    'branches': ('branches', 'branch'),
    'plans': ('plans', 'plan'),
    'subscriptions': ('subscriptions', 'subscription'),
    'users': ('users', 'user'),
    'api-keys': ('api_keys', 'api_key'),
    'enquiries': ('enquiries', 'enquiry'),
    'registrations': ('registrations', 'registration'),
    'enrollments': ('enrollments', 'enrollment'),
    'installments': ('installments', 'installment'),
    'payments': ('payments', 'payment'),
    'documents': ('documents', 'document'),
    'tasks': ('tasks', 'task'),
    'appointments': ('appointments', 'appointment'),
    'universities': ('universities', 'university'),
    'templates': ('templates', 'template'),
    'notifications': ('notifications', 'notification'),
    'agents': ('agents', 'agent'),
    'commissions': ('commissions', 'commission'),
    'refunds': ('refunds', 'refund'),
    'visa-tracking': ('visa_tracking', 'visa_tracking'),
    'follow-ups': ('follow_ups', 'follow_up'),
    'follow-up-comments': ('follow_up_comments', 'follow_up_comment'),
    'student-remarks': ('student_remarks', 'student_remark'),
    'student-documents': ('student_documents', 'student_document'),
    'transfers': ('transfers', 'transfer'),
    'signup-requests': ('signup_requests', 'signup_request'),
    'approval-requests': ('approval_requests', 'approval_request'),
}

ALL = [r.value for r in Role]
ADMINS = ['DEV_ADMIN', 'COMPANY_ADMIN']
MANAGERS_UP = ADMINS + ['HEAD_MANAGER', 'BRANCH_MANAGER']

# Read/write rule per permission class, expressed as (read_capability,
# write_capability, read_roles, write_roles). Capability-backed rules list the
# DEFAULT roles; the live matrix may widen or narrow them per company.
PERMISSION_RULES = {
    'ScopedObjectPermission': (None, None, ALL, ALL),
    'IsAuthenticatedAndActive': (None, None, ALL, ALL),
    'CanManageOwnCompany': ('manageSettings', 'manageSettings', ADMINS, ADMINS),
    'ReadOnlyOrCompanyAdmin': (None, 'manageBranches', ALL, ADMINS),
    'ReadOnlyOrManager': (None, None, ALL, MANAGERS_UP),
    'CanManageAgents': ('manageCommissions', 'manageCommissions', ADMINS, ADMINS),
    'CanManageCommissions': ('viewEarnings', 'manageCommissions', ADMINS + ['HEAD_MANAGER'], ADMINS),
    'CanManageRefunds': (None, 'manageRefunds', ALL, MANAGERS_UP),
    'AllowAny': (None, None, ALL + ['ANONYMOUS'], ALL + ['ANONYMOUS']),
    'IsDevAdmin': ('manageCompanies', 'manageCompanies', ['DEV_ADMIN'], ['DEV_ADMIN']),
}

# Hand-written knowledge about custom actions that introspection cannot see:
# the tool name the MCP server exposes, the request body and the response.
# Keyed by (router prefix, action method name).
ACTION_OVERLAY = {
    ('users', 'me'): {
        'tool_name': 'get_me', 'description': 'The calling user (UserSerializer).',
        'body': {}, 'response': 'User object',
    },
    ('users', 'change_password'): {
        'tool_name': 'change_password',
        'description': 'Change the caller\'s own password. The current password is verified.',
        'body': {'current_password': 'string, required', 'new_password': 'string, required (Django validators apply)'},
        'response': '{"status": "Password updated."}',
    },
    ('users', 'set_active'): {
        'tool_name': 'set_user_active',
        'description': 'Activate or deactivate a staff account (is_active_employee). Needs manageUsers. Deactivation revokes all of that user\'s tokens and API keys. You cannot target yourself.',
        'body': {'is_active': 'boolean, required'}, 'response': 'User object',
    },
    ('users', 'counselors'): {
        'tool_name': 'list_counselors',
        'description': 'Counselor performance rows (EMPLOYEE and BRANCH_MANAGER accounts in scope). UNPAGINATED bare array.',
        'body': {}, 'response': '[{id, name, email, avatar, branch, totalEnquiries, converted, registrations, enrollments, conversionRate}]',
    },
    ('subscriptions', 'mine'): {
        'tool_name': 'get_my_subscription', 'description': 'The caller\'s company subscription, or 404 when none.',
        'body': {}, 'response': 'Subscription object',
    },
    ('payments', 'stats'): {
        'tool_name': 'payment_stats',
        'description': 'Revenue aggregates over the caller\'s scope. Cached for SCOPED_CACHE_SECONDS (default 30 s); the X-Cache header says HIT or MISS.',
        'body': {}, 'response': '{"totalRevenue", "thisMonthRevenue", "pendingAmount", "transactionCount"}',
    },
    ('documents', 'download'): {
        'tool_name': 'download_document',
        'description': 'Stream the decrypted file. Handled by the documents tool module, not generated.',
        'body': {}, 'response': 'binary file', 'skip_generated': True,
    },
    ('documents', 'expiring_soon'): {
        'tool_name': 'documents_expiring_soon',
        'description': 'Documents whose expiry_date is on or before today + days (default 30). Paginated.',
        'body': {}, 'query': {'days': 'integer, default 30'}, 'response': 'paginated Document list',
    },
    ('tasks', 'reorder'): {
        'tool_name': 'reorder_tasks',
        'description': 'Persist kanban order. Writes `position` in the given order; when `status` is supplied it is applied to tasks whose status differs, and moving to Done sets completed_at. Ids outside the caller\'s scope are skipped.',
        'body': {'ids': 'list of task ids in order, required', 'status': 'string, optional'},
        'response': '{"reordered": n, "requested": m}',
    },
    ('appointments', 'calendar'): {
        'tool_name': 'appointments_calendar',
        'description': 'Appointments in one calendar month, after the normal filters/search. UNPAGINATED bare array.',
        'body': {}, 'query': {'month': 'integer 1-12, required', 'year': 'integer, required'}, 'response': '[Appointment]',
    },
    ('student-documents', 'return_docs'): {
        'tool_name': 'return_student_documents',
        'description': 'Mark physical documents Returned (returned_at=now, current_holder cleared). Skips rows already Returned.',
        'body': {'document_ids': 'list of student-document ids, required'},
        'response': '{"returned": n, "requested": m, "ids": [...]}',
    },
    ('notifications', 'mark_read'): {
        'tool_name': 'mark_notification_read', 'description': 'Mark one notification read.',
        'body': {}, 'response': 'Notification object',
    },
    ('notifications', 'mark_all_read'): {
        'tool_name': 'mark_all_notifications_read', 'description': 'Mark every unread notification read.',
        'body': {}, 'response': '{"updated": n}',
    },
    ('notifications', 'unread_count'): {
        'tool_name': 'unread_notification_count', 'description': 'Count of unread notifications.',
        'body': {}, 'response': '{"count": n}',
    },
    ('transfers', 'accept'): {
        'tool_name': 'accept_transfer',
        'description': 'Accept a PENDING transfer addressed to the caller. Moves owner (and branch, and assigned_to where present) to the caller.',
        'body': {}, 'response': 'RecordTransfer object',
    },
    ('transfers', 'reject'): {
        'tool_name': 'reject_transfer', 'description': 'Reject a PENDING transfer addressed to the caller.',
        'body': {}, 'response': 'RecordTransfer object',
    },
    ('transfers', 'inbox'): {
        'tool_name': 'transfer_inbox', 'description': 'PENDING transfers addressed to the caller. Paginated.',
        'body': {}, 'response': 'paginated RecordTransfer list',
    },
    ('transfers', 'outbox'): {
        'tool_name': 'transfer_outbox', 'description': 'Transfers the caller has sent, any status. Paginated.',
        'body': {}, 'response': 'paginated RecordTransfer list',
    },
    ('signup-requests', 'approve'): {
        'tool_name': 'approve_signup_request',
        'description': 'DEV_ADMIN. Provision the company (Head Office branch, active subscription) and its COMPANY_ADMIN account.',
        'body': {}, 'response': '{"status": "approved", "company": id, "user": id}',
    },
    ('signup-requests', 'reject'): {
        'tool_name': 'reject_signup_request', 'description': 'DEV_ADMIN. Reject a pending signup request.',
        'body': {'reason': 'string'}, 'response': '{"status": "rejected"}',
    },
    ('approval-requests', 'pending_count'): {
        'tool_name': 'approval_pending_count', 'description': 'Count of approval requests in the caller\'s queue.',
        'body': {}, 'response': '{"count": n}',
    },
    ('approval-requests', 'my_requests'): {
        'tool_name': 'my_approval_requests', 'description': 'Approval requests the caller raised. Paginated.',
        'body': {}, 'response': 'paginated ApprovalRequest list',
    },
    ('approval-requests', 'approve'): {
        'tool_name': 'approve_approval_request',
        'description': 'Needs reviewApprovals. Re-checks the reviewer\'s write scope on the live target. DELETE deletes it; UPDATE applies only allowlisted fields (see approvals.mutable_fields).',
        'body': {'note': 'string, optional review note'}, 'response': 'ApprovalRequest object',
    },
    ('approval-requests', 'reject'): {
        'tool_name': 'reject_approval_request', 'description': 'Needs reviewApprovals.',
        'body': {'note': 'string, optional'}, 'response': 'ApprovalRequest object',
    },
    ('api-keys', 'revoke'): {
        'tool_name': 'revoke_api_key',
        'description': 'Revoke a personal API key. Not callable when authenticated with an API key.',
        'body': {}, 'response': 'ApiKey object',
    },
}

RESOURCE_NOTES = {
    'registrations': [
        'Creating a registration also creates a Payment (type Registration, amount = registration_fee, '
        'status Success when payment_status is "Paid" case-insensitively, else Pending).',
        'registration_no is server-assigned as REG-<year>-NNN when omitted.',
        'There is no convert endpoint: to convert an enquiry, create a registration with `enquiry` set.',
    ],
    'enrollments': [
        'enrollment_no is server-assigned as ENR-<year>-NNN when omitted.',
        'Pass installments_count (and optionally installment_amount) to have the server build Installment rows '
        'that sum exactly to total_fees, due monthly from start_date. Never build schedules client-side.',
        'student must be a Registration id in the caller\'s company; university may be a shared (company=null) row.',
    ],
    'installments': ['Read-only in practice: POST cannot work because `enrollment` is read-only on the serializer.'],
    'payments': ['Only status Success counts as revenue. metadata is a free JSON object for method detail.'],
    'documents': [
        'Uploads are multipart/form-data with a write-only `file` field; JSON is accepted for metadata-only writes.',
        'A document links to at most one of registration / enquiry; student_name is derived from that link.',
        'Files are encrypted at rest; download only via documents/{id}/download/.',
    ],
    'student-documents': ['Custody of PHYSICAL originals, distinct from uploaded scans (documents).'],
    'follow-up-comments': ['Append-only: update and delete return 403.'],
    'student-remarks': ['Append-only: update and delete return 403.'],
    'universities': ['Rows with company=null are a shared catalogue visible to every tenant.'],
    'notifications': ['Read-only; created by server signals (currently: new enrollment).'],
    'agents': ['total_earned, pending_amount, students_referred are recomputed by signals from commissions.'],
    'commissions': ['agent and commission_amount (>= 0.01) are required on create.'],
    'visa-tracking': ['passport_no is encrypted; it cannot be filtered or searched.'],
    'transfers': [
        'Manager-level senders apply immediately (requires_acceptance=false); employee-to-employee stays PENDING until accepted.',
        'A transfer MOVES ownership: the sender loses access.',
    ],
    'approval-requests': [
        'Employees (no deleteRecords) delete or update restricted fields by raising a request here.',
        'entity_type must be one of the transfers/approvals allowlist; `appointment` is accepted by the model but rejected at validation.',
    ],
    'users': [
        'Serializer depends on the CALLER: admins get UserAdminSerializer (role, branch, password, managed_managers writable).',
        'Head/branch managers may only create EMPLOYEE accounts in their own branches.',
        # permission_classes/read_roles/write_roles below are the viewset-level
        # defaults; UserViewSet.get_permissions() varies them per action.
        'Permissions vary BY ACTION, so the role lists above are the read default only: '
        'create needs CanCreateStaff (admins, or a head/branch manager creating an employee), '
        'destroy and set-active need manageUsers, counselors needs manageCounselors, '
        'and everything else needs only an authenticated active account.',
    ],
    'companies': [
        # `fields` below is probed anonymously, so CompanyViewSet.get_serializer_class
        # returns CompanyProfileSerializer and `is_active` comes back read-only.
        # Without this note a generated update_company tool would refuse the one
        # write a DEV_ADMIN needs it for.
        'The serializer depends on the CALLER, so the read_only flags below are the NARROW view: '
        'a DEV_ADMIN gets CompanySerializer, where `is_active` is writable. Everyone else gets '
        'CompanyProfileSerializer, which adds `is_active` to the read-only set.',
        '`is_active` is the tenant suspension switch, writable by DEV_ADMIN only: a company the '
        'operator has disabled must not be able to re-enable itself.',
        '`slug`, `created_at` and `subscription` are read-only for EVERY caller, so a company admin '
        'cannot change the tenant key or lift their own plan, seat and branch caps.',
        'A COMPANY_ADMIN may edit only name, email, phone and address on their own company.',
    ],
    'branches': ['The default branch cannot be deleted; a branch with users cannot be deleted.'],
    'signup-requests': [
        # As above: SignupRequestViewSet.get_permissions() varies per action, so
        # the viewset-level role lists cannot express this.
        'Permissions vary BY ACTION, so the role lists above do not apply: create is PUBLIC (AllowAny, '
        'throttled at the signup scope, 5/hour) and EVERY other action — list, retrieve, update, delete, '
        'approve, reject — is DEV_ADMIN only.',
        'This is the self-service tenant signup queue, not a record inside a company.',
    ],
    'api-keys': [
        'Keys are created only for the caller; the plaintext is returned once.',
        # `fields` below is the READ shape (ApiKeySerializer, every field read-only).
        # POST uses ApiKeyCreateSerializer, which introspection of the viewset's
        # serializer_class cannot see, so the create body is spelled out here.
        'POST body is {"name": "string, required, max 80", "expires_at": "ISO datetime, optional, must be in the future"}. '
        'The 201 response is the key object plus a one-time plaintext `key`.',
        'There is no detail route and no list/retrieve by id: only GET api-keys/, POST api-keys/ and '
        'POST api-keys/{id}/revoke/. GET accepts ?user=<id> for company admins (own company) and dev admins.',
    ],
}

ANALYTICS = [
    ('analytics/overview/', 'IsAuthenticatedAndActive', {}, 'object: enquiries, registrations, enrollments, converted, conversionRate, revenueThisMonth, totalRevenue, pendingPayments and month-over-month trends'),
    ('analytics/funnel/', 'IsManagerOrAbove (viewAnalytics)', {}, '{"stages": [{stage, count, rate}], "dropOff": {...}}'),
    ('analytics/revenue/', 'IsManagerOrAbove (viewAnalytics)', {'months': 'int 1-36, default 12'}, '{"series": [{month, label, revenue, transactions, registrationFees, enrollmentFees, otherFees, commissions}]}'),
    ('analytics/branches/', 'IsManagerOrAbove (viewAnalytics)', {}, 'bare array of {id, name, city, staff, enquiries, registrations, enrollments, revenue, conversionRate}'),
    ('analytics/visa-pipeline/', 'IsAuthenticatedAndActive', {}, '{"pipeline": [{stage, count}], "total": n}'),
    ('analytics/sources/', 'IsManagerOrAbove (viewAnalytics)', {}, 'bare array of {source, total, converted, conversionRate}'),
]


def _choices(field):
    choices = getattr(field, 'choices', None)
    if not choices:
        return None
    out = []
    items = choices.items() if hasattr(choices, 'items') else choices
    for value, label in items:
        out.append({'value': value, 'label': str(label)})
    return out


def _field_type(field):
    mapping = (
        (drf_serializers.BooleanField, 'boolean'),
        (drf_serializers.IntegerField, 'integer'),
        (drf_serializers.DecimalField, 'decimal'),
        (drf_serializers.FloatField, 'number'),
        (drf_serializers.DateTimeField, 'datetime'),
        (drf_serializers.DateField, 'date'),
        (drf_serializers.TimeField, 'time'),
        (drf_serializers.FileField, 'file'),
        (drf_serializers.JSONField, 'json'),
        (drf_serializers.ListField, 'list'),
        (drf_serializers.ManyRelatedField, 'list_of_ids'),
        (drf_serializers.PrimaryKeyRelatedField, 'id'),
        (drf_serializers.EmailField, 'email'),
        (drf_serializers.URLField, 'url'),
        (drf_serializers.ChoiceField, 'choice'),
        (drf_serializers.CharField, 'string'),
        (drf_serializers.BaseSerializer, 'object'),
        (drf_serializers.SerializerMethodField, 'computed'),
    )
    for klass, name in mapping:
        if isinstance(field, klass):
            return name
    return 'string'


def _related_model(field):
    qs = getattr(field, 'queryset', None)
    if qs is None and isinstance(field, drf_serializers.ManyRelatedField):
        qs = getattr(field.child_relation, 'queryset', None)
    if qs is not None:
        return qs.model.__name__
    return None


class _AnonymousProbe:
    """Enough of a user for serializer __init__ scoping to run without a database."""
    is_authenticated = False
    company_id = None
    is_dev_admin = False
    can_manage_users = False
    role = None


def _fake_request():
    factory = APIRequestFactory()
    request = Request(factory.get('/'))
    request.user = _AnonymousProbe()
    return request


def _serializer_fields(viewset_class):
    view = viewset_class()
    view.action = 'create'
    view.request = _fake_request()
    view.format_kwarg = None
    try:
        serializer_class = view.get_serializer_class()
    except Exception:
        serializer_class = viewset_class.serializer_class
    serializer = serializer_class(context={'request': view.request, 'view': view})
    out = []
    for name, field in serializer.fields.items():
        out.append({
            'name': name,
            'type': _field_type(field),
            'required': bool(getattr(field, 'required', False)) and not field.read_only,
            'read_only': bool(field.read_only),
            'write_only': bool(getattr(field, 'write_only', False)),
            'choices': _choices(field) if isinstance(field, drf_serializers.ChoiceField) else None,
            'max_length': getattr(field, 'max_length', None),
            'related_model': _related_model(field),
            'help': str(getattr(field, 'help_text', '') or ''),
        })
    return out


def _model_choices_for(model, field_name):
    if model is None:
        return None
    try:
        f = model._meta.get_field(field_name)
    except Exception:
        return None
    if getattr(f, 'choices', None):
        return [c[0] for c in f.choices]
    return None


def _queryset_model(viewset_class):
    """The model the viewset lists, or None for viewsets that build it per request."""
    queryset = getattr(viewset_class, 'queryset', None)
    return queryset.model if queryset is not None else None


def _filters(viewset_class):
    out = []
    fs = getattr(viewset_class, 'filterset_class', None)
    if fs is not None:
        for param, flt in fs.base_filters.items():
            if isinstance(flt, JSONContainsAnyFilter):
                kind = 'json_any'
            elif isinstance(flt, MultiValueIdFilter):
                kind = 'multi_id'
            elif isinstance(flt, MultiValueFilter):
                kind = 'multi'
            elif isinstance(flt, df.BooleanFilter):
                kind = 'boolean'
            else:
                kind = 'exact'
            lookup = f'{flt.field_name}__in' if kind in ('multi', 'multi_id') else flt.field_name
            out.append({
                'param': param, 'kind': kind, 'lookup': lookup,
                'choices': _model_choices_for(fs._meta.model, flt.field_name) if kind == 'multi' else None,
            })
        return out
    model = _queryset_model(viewset_class)
    for name in getattr(viewset_class, 'filterset_fields', ()) or ():
        out.append({'param': name, 'kind': 'exact', 'lookup': name, 'choices': _model_choices_for(model, name)})
    return out


# The six routable viewset actions, in the order a reader thinks about them.
# ModelViewSet supplies them as mixin methods, so presence on the class is what
# decides whether the router builds a route.
VERB_HANDLERS = ('list', 'retrieve', 'create', 'update', 'partial_update', 'destroy')


def _methods(viewset_class):
    verbs = []
    if hasattr(viewset_class, 'list') or hasattr(viewset_class, 'retrieve'):
        verbs.append('GET')
    if hasattr(viewset_class, 'create'):
        verbs.append('POST')
    if hasattr(viewset_class, 'partial_update'):
        verbs.append('PATCH')
    if hasattr(viewset_class, 'update'):
        verbs.append('PUT')
    if hasattr(viewset_class, 'destroy'):
        verbs.append('DELETE')
    return verbs


def _verbs(viewset_class):
    """
    Which of the six actions the viewset actually defines.

    `methods` collapses list and retrieve into a single GET and so cannot say
    "lists, but has no detail route" — which is exactly ApiKeyViewSet, a
    GenericViewSet with `list` and `create` and nothing else. A generator
    reading GET alone emits a get_api_key tool pointing at a URL the router
    never built. Read this rather than `methods` when deciding which tools to
    emit; `methods` stays the HTTP-verb summary.
    """
    return {name: hasattr(viewset_class, name) for name in VERB_HANDLERS}


# Permission classes that only establish "authenticated, active and scoped to
# the tenant". They say nothing about capabilities, so a viewset that lists one
# ALONGSIDE a capability-bearing class is governed by the latter.
BASELINE_PERMISSIONS = ('ScopedObjectPermission', 'IsAuthenticatedAndActive')


def _permission_summary(viewset_class):
    names = [p.__name__ for p in getattr(viewset_class, 'permission_classes', [])]
    names = [n for n in names if n != 'SubscriptionActive'] or ['IsAuthenticatedAndActive']

    # Take the most specific rule, not `names[0]`. agents/, commissions/ and
    # refunds/ all declare [ScopedObjectPermission, CanManage..., ...], so
    # reading the first entry reports the generic tenant scope and loses the
    # capability the server actually enforces — the catalog would claim every
    # role may write a commission or a refund.
    specific = [n for n in names if n not in BASELINE_PERMISSIONS and n in PERMISSION_RULES]
    chosen = specific[0] if specific else names[0]
    rule = PERMISSION_RULES.get(chosen, PERMISSION_RULES['IsAuthenticatedAndActive'])
    return names, rule


def _actions(prefix, viewset_class):
    out = []
    for attr in dir(viewset_class):
        fn = getattr(viewset_class, attr, None)
        mapping = getattr(fn, 'mapping', None)
        if not mapping or not hasattr(fn, 'detail'):
            continue
        url_path = getattr(fn, 'url_path', attr)
        method = sorted(m.upper() for m in mapping)[0]
        overlay = ACTION_OVERLAY.get((prefix, attr), {})
        path = f'{prefix}/{{id}}/{url_path}/' if fn.detail else f'{prefix}/{url_path}/'
        out.append({
            'name': attr,
            'tool_name': overlay.get('tool_name', f'{attr}_{RESOURCE_NAMES[prefix][1]}'),
            'method': method,
            'detail': bool(fn.detail),
            'path': path,
            'description': overlay.get('description', (fn.__doc__ or '').strip()),
            'body': overlay.get('body', {}),
            'query': overlay.get('query', {}),
            'response': overlay.get('response', ''),
            'skip_generated': overlay.get('skip_generated', False),
        })
    out.sort(key=lambda a: a['name'])
    return out


def _resource(prefix, viewset_class):
    """
    One resource entry. EVERY key below is always present, even when empty —
    consumers index into this shape rather than testing for keys.

        prefix, name, singular, model, entity_type
        methods                     HTTP verbs the viewset answers
        verbs                       the six routable actions, as booleans;
                                    read this, not `methods`, to decide which
                                    tools exist (see _verbs)
        list_paginated
        permission_classes, read_capability, write_capability,
        read_roles, write_roles, delete_requires_capability
        fields, filters, search_fields, ordering_fields
        actions                     custom @action routes
        notes                       hand-written knowledge introspection
                                    cannot reach (see RESOURCE_NOTES)
    """
    plural, singular = RESOURCE_NAMES[prefix]
    names, (read_cap, write_cap, read_roles, write_roles) = _permission_summary(viewset_class)
    model = _queryset_model(viewset_class)
    is_scoped = issubclass(viewset_class, ScopedModelViewSet)
    return {
        'prefix': prefix,
        'name': plural,
        'singular': singular,
        'model': model.__name__ if model is not None else None,
        'entity_type': getattr(viewset_class, 'entity_type', None),
        'methods': _methods(viewset_class),
        'verbs': _verbs(viewset_class),
        'list_paginated': getattr(viewset_class, 'pagination_class', 'default') is not None,
        'permission_classes': names,
        'read_capability': read_cap,
        'write_capability': write_cap,
        'read_roles': list(read_roles),
        'write_roles': list(write_roles),
        'delete_requires_capability': 'deleteRecords' if is_scoped else None,
        'fields': _serializer_fields(viewset_class),
        'filters': _filters(viewset_class),
        'search_fields': list(getattr(viewset_class, 'search_fields', ()) or ()),
        'ordering_fields': list(getattr(viewset_class, 'ordering_fields', ()) or ()),
        'actions': _actions(prefix, viewset_class),
        'notes': RESOURCE_NOTES.get(prefix, []),
    }


def _enum(name, choices, out):
    out[name] = [{'value': c[0], 'label': str(c[1])} for c in choices]


def _enums():
    out = {}
    _enum('Role', Role.choices, out)
    _enum('Capability', Capability.choices, out)
    _enum('Subscription.status', Subscription.Status.choices, out)
    _enum('Enquiry.status', Enquiry.Status.choices, out)
    _enum('Payment.status', Payment.Status.choices, out)
    _enum('Document.status', Document.Status.choices, out)
    _enum('Appointment.type', Appointment.TYPE_CHOICES, out)
    _enum('Appointment.status', Appointment.STATUS_CHOICES, out)
    _enum('Template.category', Template.CATEGORY_CHOICES, out)
    _enum('Notification.type', Notification.TYPE_CHOICES, out)
    _enum('Commission.status', Commission.STATUS_CHOICES, out)
    _enum('Refund.status', Refund.Status.choices, out)
    _enum('VisaTracking.current_stage', VisaTracking.STAGE_CHOICES, out)
    _enum('FollowUp.outcome_status', FollowUp.Outcome.choices, out)
    _enum('FollowUp.admission_possibility', FollowUp.Likelihood.choices, out)
    _enum('SignupRequest.status', SignupRequest.STATUS_CHOICES, out)
    _enum('ApprovalRequest.action', ApprovalRequest.Action.choices, out)
    _enum('ApprovalRequest.status', ApprovalRequest.Status.choices, out)
    _enum('ApprovalRequest.entity_type', ApprovalRequest.ENTITY_CHOICES, out)
    _enum('RecordTransfer.status', RecordTransfer.Status.choices, out)
    _enum('RecordTransfer.entity_type', RecordTransfer.ENTITY_CHOICES, out)
    _enum('StudentDocument.status', StudentDocument.Status.choices, out)
    return out


def _roles():
    return {
        'rank': {r.value: rank for r, rank in capabilities.ROLE_RANK.items()},
        'defaults': {cap.value: [r.value for r in roles] for cap, roles in capabilities.DEFAULTS.items()},
        'protected': {
            cap.value: {'floor': floor.value, 'reason': reason}
            for cap, (floor, reason) in capabilities.PROTECTED.items()
        },
        'admin_essentials': [c.value for c in capabilities.ADMIN_ESSENTIALS],
        'visibility': {
            'DEV_ADMIN': 'everything, all companies',
            'COMPANY_ADMIN': 'everything in own company',
            'HEAD_MANAGER': 'records in the branches of the branch managers assigned to them (managed_managers), plus own branch',
            'BRANCH_MANAGER': 'records in own branch',
            'EMPLOYEE': 'records they OWN (owner field), plus records transferred to them and accepted',
        },
    }


def _conventions():
    # Production rates, not the DEBUG-relaxed ones, so the committed catalog
    # does not depend on the generating machine's .env.
    from config.settings import _throttle_rates
    rates = _throttle_rates(False)
    return {
        'base_path': '/api/',
        'trailing_slash_required': True,
        'auth': {
            'api_key': 'Authorization: Bearer cdk_... (or X-API-Key)',
            'jwt': 'POST auth/login/ {username,password} -> {access, refresh, user}; access lifetime minutes; POST auth/refresh/ {refresh} rotates both',
        },
        'pagination': {
            'style': 'page number', 'page_param': 'page', 'page_size_param': 'page_size',
            'default_page_size': 25, 'max_page_size': 200,
            'envelope': ['count', 'pages', 'page', 'page_size', 'next', 'previous', 'results'],
            'bare_array_endpoints': ['users/counselors/', 'appointments/calendar/', 'analytics/branches/', 'analytics/sources/', 'plans/'],
        },
        'errors': {
            'shape': '{"error": "<message>"} or {"error": "Validation failed", "fields": {...}}',
            '409': 'That operation conflicts with existing data.',
        },
        'multi_value_query_params': 'repeat the key: ?status=New&status=Contacted (never comma-separated)',
        'search_param': 'search', 'ordering_param': 'ordering (prefix - for descending)',
        'throttle_rates': dict(rates),
        'cache_header': 'X-Cache: HIT | MISS | DISABLED on analytics and payments/stats',
        'uploads': {
            'max_bytes': settings.MAX_DOCUMENT_SIZE_BYTES,
            'allowed_extensions': list(settings.ALLOWED_DOCUMENT_EXTENSIONS),
            'content_type': 'multipart/form-data',
        },
    }


def build_catalog():
    resources = []
    for prefix, viewset_class, _basename in router.registry:
        resources.append(_resource(prefix, viewset_class))
    resources.sort(key=lambda r: r['prefix'])

    standalone = [
        {'path': 'auth/login/', 'method': 'POST', 'permission': 'AllowAny', 'throttle': 'login 8/min',
         'body': {'username': 'string', 'password': 'string'}, 'response': '{"access", "refresh", "user"}; 403 when deactivated'},
        {'path': 'auth/refresh/', 'method': 'POST', 'permission': 'AllowAny', 'throttle': '',
         'body': {'refresh': 'string'}, 'response': '{"access", "refresh"} (rotation)'},
        {'path': 'auth/logout/', 'method': 'POST', 'permission': 'IsAuthenticatedAndActive', 'throttle': '',
         'body': {'refresh': 'string'}, 'response': '205 empty'},
        {'path': 'role-permissions/', 'method': 'GET', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {}, 'query': {'company': 'DEV_ADMIN only'}, 'response': '{company, company_name, roles[], capabilities[], matrix{role:{capability:{allowed, source, editable, can_grant, can_revoke, reason}}}}'},
        {'path': 'role-permissions/', 'method': 'PUT', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {'changes': '[{role, capability, allowed: true|false|null}]', 'company': 'DEV_ADMIN only'},
         'response': 'same as GET; whole batch refused if any cell is refused'},
        {'path': 'role-permissions/', 'method': 'DELETE', 'permission': 'CanManageSettings (manageSettings)', 'throttle': '',
         'body': {}, 'query': {'company': 'DEV_ADMIN only'}, 'response': 'defaults restored; same payload as GET'},
        {'path': 'role-permissions/mine/', 'method': 'GET', 'permission': 'IsAuthenticatedAndActive', 'throttle': '',
         'body': {}, 'response': '{"role": "...", "capabilities": [...]}'},
        {'path': 'health/', 'method': 'GET', 'permission': 'AllowAny', 'throttle': 'anon',
         'body': {}, 'response': '{"status": "ok"} or 503 {"status": "degraded"}'},
    ]
    for path, permission, query, response in ANALYTICS:
        standalone.append({'path': path, 'method': 'GET', 'permission': permission, 'throttle': '',
                           'body': {}, 'query': query, 'response': response})

    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'resources': resources,
        'standalone_endpoints': standalone,
        'enums': _enums(),
        'roles': _roles(),
        'approvals': {
            'entity_types': [c[0] for c in ApprovalRequest.ENTITY_CHOICES],
            'resolvable_entity_types': sorted(services.ENTITY_MODELS.keys()),
            # Sorted, not `list(...)`: MUTABLE_FIELDS holds SETS, whose
            # iteration order varies between interpreter runs. Emitting it raw
            # would make the committed catalog differ from a regeneration of
            # itself, and the freshness test would fail at random.
            'mutable_fields': {k: sorted(v) for k, v in ApprovalRequestViewSet.MUTABLE_FIELDS.items()},
            'review_capability': 'reviewApprovals',
            'direct_delete_capability': 'deleteRecords',
        },
        'transfers': {
            'transferable': sorted(services.TRANSFERABLE),
            'immediate_for_roles': MANAGERS_UP,
            'requires_acceptance_for_roles': ['EMPLOYEE'],
        },
        'conventions': _conventions(),
        'encrypted_fields': ['Enquiry.date_of_birth', 'Registration.date_of_birth', 'VisaTracking.passport_no'],
    }


def render_tools_markdown(catalog):
    """A human-readable table of every tool the MCP server will expose."""
    lines = ['# ConsultancyDev MCP tools', '', 'Generated from `mcp_server/catalog.json`. Do not edit by hand.', '',
             '| Tool | Kind | API | Capability |', '|---|---|---|---|']
    for r in catalog['resources']:
        cap = r['write_capability'] or r['read_capability'] or ''
        # Driven by `verbs`, not `methods`: a viewset with `list` but no
        # `retrieve` must not get a get_<singular> row for a route that does
        # not exist. See _verbs.
        verbs = r['verbs']
        if verbs['list']:
            lines.append(f"| `list_{r['name']}` | list | GET {r['prefix']}/ | {r['read_capability'] or ''} |")
        if verbs['retrieve']:
            lines.append(f"| `get_{r['singular']}` | read | GET {r['prefix']}/{{id}}/ | {r['read_capability'] or ''} |")
        if verbs['create']:
            lines.append(f"| `create_{r['singular']}` | write | POST {r['prefix']}/ | {cap} |")
        if verbs['update'] or verbs['partial_update']:
            lines.append(f"| `update_{r['singular']}` | write | PATCH {r['prefix']}/{{id}}/ | {cap} |")
        if verbs['destroy']:
            lines.append(f"| `delete_{r['singular']}` | destructive | DELETE {r['prefix']}/{{id}}/ | {r['delete_requires_capability'] or cap} |")
        for a in r['actions']:
            lines.append(f"| `{a['tool_name']}` | action | {a['method']} {a['path']} | |")
    for name in ('analytics_overview', 'analytics_funnel', 'analytics_revenue', 'analytics_branches',
                 'analytics_visa_pipeline', 'analytics_sources', 'health'):
        lines.append(f'| `{name}` | analytics | GET | |')
    for name in ('whoami', 'my_capabilities', 'explain_permission', 'upload_document', 'download_document',
                 'student_360', 'convert_enquiry_to_registration', 'enroll_student', 'record_payment',
                 'search_everything', 'daily_briefing', 'get_role_permissions', 'update_role_permissions',
                 'reset_role_permissions'):
        lines.append(f'| `{name}` | composite | multiple | |')
    return '\n'.join(lines) + '\n'
