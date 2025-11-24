"""
WebSocket consumer for real-time updates
"""
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth import get_user_model

User = get_user_model()


class UpdatesConsumer(AsyncJsonWebsocketConsumer):
    """
    WebSocket consumer that handles real-time updates for a company.
    Employees join a room based on their company_id to receive updates.
    """
    
    async def connect(self):
        """Handle WebSocket connection"""
        # Get user from scope (added by AuthMiddleware)
        self.user = self.scope.get('user')
        
        # Only allow authenticated users
        if not self.user or not self.user.is_authenticated:
            await self.close()
            return
        
        # Get company_id for this user
        company_id = await self.get_company_id()
        
        if not company_id:
            # DEV_ADMIN doesn't have company_id, use special room
            self.room_name = 'dev_admin'
        else:
            self.room_name = f'company_{company_id}'
        
        self.room_group_name = f'updates_{self.room_name}'
        
        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        
        await self.accept()
        
        # Send connection confirmation
        await self.send_json({
            'type': 'connection_established',
            'message': 'Connected to real-time updates'
        })
    
    async def disconnect(self, close_code):
        """Handle WebSocket disconnection"""
        # Leave room group
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )
    
    async def receive_json(self, content):
        """Handle messages from WebSocket (ping/pong for keep-alive)"""
        if content.get('type') == 'ping':
            await self.send_json({'type': 'pong'})
    
    async def broadcast_update(self, event):
        """
        Handle broadcast_update events from channel layer.
        Forward the event to WebSocket client.
        """
        await self.send_json({
            'type': 'update',
            'entity': event['entity'],  # e.g., 'enquiry', 'registration'
            'action': event['action'],  # e.g., 'created', 'updated', 'deleted'
            'data': event['data']
        })
    
    @database_sync_to_async
    def get_company_id(self):
        """Get company_id for the current user"""
        try:
            user = User.objects.get(id=self.user.id)
            return user.company_id
        except User.DoesNotExist:
            return None
