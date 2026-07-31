"""
Model signals.

The previous version of this file existed to push WebSocket broadcasts. That
feature has been removed, and it was broken anyway: every handler passed
`company_id=None`, which routed all events to a single global room that normal
users never joined, while any user with a blank company landed in that room and
received other tenants' activity.

What remains is derived-state maintenance and notification fan-out, both cheap
and in-process.
"""

import logging

from django.db.models import Count, Q, Sum
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from . import capabilities
from .models import (
    Agent, Commission, Enrollment, Notification, Registration, Role,
    RolePermission, User,
)

logger = logging.getLogger('core')


@receiver(post_save, sender=RolePermission)
@receiver(post_delete, sender=RolePermission)
def role_permission_changed(sender, instance, **kwargs):
    """
    Drop the company's cached capability matrix whenever a row moves.

    The API already invalidates once per batch, which is cheaper. This exists
    for every OTHER writer — the Django admin, a management command, a data
    migration, a shell session — because a permission change that the running
    process keeps serving from cache is a security decision that did not take
    effect.
    """
    capabilities.invalidate(instance.company_id)


def notify(users, title, message='', type='info', action_url=''):
    """Create notifications in one query instead of one INSERT per recipient."""
    recipients = [u for u in users if u is not None]
    if not recipients:
        return
    Notification.objects.bulk_create([
        Notification(
            user=user,
            company_id=user.company_id,
            title=title,
            message=message,
            type=type,
            action_url=action_url,
        )
        for user in recipients
    ])


def _recalculate_agent_totals(agent_id):
    """
    Recompute an agent's stored aggregates from their commission rows.

    These columns were previously written by nothing at all, so the figures
    shown in the UI were whatever the row happened to be seeded with.
    """
    if not agent_id:
        return
    totals = Commission.objects.filter(agent_id=agent_id).aggregate(
        paid=Sum('commission_amount', filter=Q(status='Paid')),
        pending=Sum('commission_amount', filter=Q(status='Pending')),
        referred=Count('student', distinct=True),
    )
    Agent.objects.filter(pk=agent_id).update(
        total_earned=totals['paid'] or 0,
        pending_amount=totals['pending'] or 0,
        students_referred=totals['referred'] or 0,
    )


@receiver(post_save, sender=Commission)
def commission_saved(sender, instance, **kwargs):
    _recalculate_agent_totals(instance.agent_id)


@receiver(post_delete, sender=Commission)
def commission_deleted(sender, instance, **kwargs):
    _recalculate_agent_totals(instance.agent_id)


@receiver(post_save, sender=Enrollment)
def enrollment_created(sender, instance, created, **kwargs):
    """Notify the company admins and the owning branch's manager."""
    if not created or not instance.company_id:
        return

    recipients = User.objects.filter(
        company_id=instance.company_id, is_active=True,
    ).filter(
        Q(role=Role.COMPANY_ADMIN)
        | Q(role=Role.BRANCH_MANAGER, branch_id=instance.branch_id)
    )
    notify(
        list(recipients),
        title='New enrollment',
        message=f'{instance.enrollment_no} — {instance.program_name}',
        type='success',
        action_url=f'/app/enrollments/{instance.pk}',
    )


@receiver(post_save, sender=Registration)
def registration_created(sender, instance, created, **kwargs):
    if created:
        logger.info(
            'Registration %s created for company %s', instance.pk, instance.company_id,
        )
