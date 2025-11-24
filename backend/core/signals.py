"""
Django signals for broadcasting real-time updates
"""
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from .models import (
    Enquiry, Registration, Enrollment, Payment,
    Document, Task, Appointment, Notification,
    FollowUp, User
)


def broadcast_event(entity_type, action, instance, company_id=None):
    """
    Broadcast an event to all WebSocket connections in the same company room.
    
    Args:
        entity_type: Type of entity (e.g., 'enquiry', 'registration')
        action: Action performed ('created', 'updated', 'deleted')
        instance: The model instance
        company_id: Company ID to broadcast to (None for all)
    """
    channel_layer = get_channel_layer()
    
    if not channel_layer:
        return
    
    # Determine which room to broadcast to
    if company_id:
        room_group_name = f'updates_company_{company_id}'
    else:
        room_group_name = 'updates_dev_admin'
    
    # Prepare event data
    event_data = {
        'type': 'broadcast_update',
        'entity': entity_type,
        'action': action,
        'data': {
            'id': instance.id if hasattr(instance, 'id') else None,
        }
    }
    
    # Broadcast to room
    try:
        async_to_sync(channel_layer.group_send)(
            room_group_name,
            event_data
        )
    except Exception as e:
        print(f"Error broadcasting event: {e}")


# Enquiry signals
@receiver(post_save, sender=Enquiry)
def enquiry_saved(sender, instance, created, **kwargs):
    """Broadcast when enquiry is created or updated"""
    action = 'created' if created else 'updated'
    # Enquiries don't have company_id, broadcast to all
    broadcast_event('enquiry', action, instance, company_id=None)


@receiver(post_delete, sender=Enquiry)
def enquiry_deleted(sender, instance, **kwargs):
    """Broadcast when enquiry is deleted"""
    broadcast_event('enquiry', 'deleted', instance, company_id=None)


# Registration signals
@receiver(post_save, sender=Registration)
def registration_saved(sender, instance, created, **kwargs):
    """Broadcast when registration is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('registration', action, instance, company_id=None)


@receiver(post_delete, sender=Registration)
def registration_deleted(sender, instance, **kwargs):
    """Broadcast when registration is deleted"""
    broadcast_event('registration', 'deleted', instance, company_id=None)


# Enrollment signals
@receiver(post_save, sender=Enrollment)
def enrollment_saved(sender, instance, created, **kwargs):
    """Broadcast when enrollment is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('enrollment', action, instance, company_id=None)


@receiver(post_delete, sender=Enrollment)
def enrollment_deleted(sender, instance, **kwargs):
    """Broadcast when enrollment is deleted"""
    broadcast_event('enrollment', 'deleted', instance, company_id=None)


# Payment signals
@receiver(post_save, sender=Payment)
def payment_saved(sender, instance, created, **kwargs):
    """Broadcast when payment is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('payment', action, instance, company_id=None)


@receiver(post_delete, sender=Payment)
def payment_deleted(sender, instance, **kwargs):
    """Broadcast when payment is deleted"""
    broadcast_event('payment', 'deleted', instance, company_id=None)


# Document signals
@receiver(post_save, sender=Document)
def document_saved(sender, instance, created, **kwargs):
    """Broadcast when document is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('document', action, instance, company_id=None)


@receiver(post_delete, sender=Document)
def document_deleted(sender, instance, **kwargs):
    """Broadcast when document is deleted"""
    broadcast_event('document', 'deleted', instance, company_id=None)


# Task signals
@receiver(post_save, sender=Task)
def task_saved(sender, instance, created, **kwargs):
    """Broadcast when task is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('task', action, instance, company_id=None)


@receiver(post_delete, sender=Task)
def task_deleted(sender, instance, **kwargs):
    """Broadcast when task is deleted"""
    broadcast_event('task', 'deleted', instance, company_id=None)


# FollowUp signals
@receiver(post_save, sender=FollowUp)
def followup_saved(sender, instance, created, **kwargs):
    """Broadcast when follow-up is created or updated"""
    action = 'created' if created else 'updated'
    broadcast_event('followup', action, instance, company_id=None)


@receiver(post_delete, sender=FollowUp)
def followup_deleted(sender, instance, **kwargs):
    """Broadcast when follow-up is deleted"""
    broadcast_event('followup', 'deleted', instance, company_id=None)


# Notification signals (only broadcast created, as they're usually not updated/deleted)
@receiver(post_save, sender=Notification)
def notification_created(sender, instance, created, **kwargs):
    """Broadcast when notification is created"""
    if created:
        # Get user's company_id
        company_id = instance.user.company_id if hasattr(instance.user, 'company_id') else None
        broadcast_event('notification', 'created', instance, company_id=company_id)


# User signals (for user management updates)
@receiver(post_save, sender=User)
def user_saved(sender, instance, created, **kwargs):
    """Broadcast when user is created or updated"""
    action = 'created' if created else 'updated'
    company_id = instance.company_id
    broadcast_event('user', action, instance, company_id=company_id)


@receiver(post_delete, sender=User)
def user_deleted(sender, instance, **kwargs):
    """Broadcast when user is deleted"""
    company_id = instance.company_id
    broadcast_event('user', 'deleted', instance, company_id=company_id)
