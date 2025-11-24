from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    UserViewSet, EnquiryViewSet, RegistrationViewSet, 
    EnrollmentViewSet, PaymentViewSet, DocumentViewSet,
    DocumentTransferViewSet, TaskViewSet, AppointmentViewSet,
    UniversityViewSet, TemplateViewSet, NotificationViewSet,
    CommissionViewSet, RefundViewSet, LeadSourceViewSet,
    VisaTrackingViewSet, FollowUpViewSet, InstallmentViewSet,
    AgentViewSet, ChatConversationViewSet, ChatMessageViewSet,
    GroupChatViewSet, SignupRequestViewSet, ApprovalRequestViewSet
)

router = DefaultRouter()
router.register(r'users', UserViewSet)
router.register(r'enquiries', EnquiryViewSet)
router.register(r'registrations', RegistrationViewSet)
router.register(r'enrollments', EnrollmentViewSet)
router.register(r'installments', InstallmentViewSet)
router.register(r'payments', PaymentViewSet)
router.register(r'documents', DocumentViewSet)
router.register(r'document-transfers', DocumentTransferViewSet)
router.register(r'tasks', TaskViewSet)
router.register(r'appointments', AppointmentViewSet)
router.register(r'universities', UniversityViewSet)
router.register(r'templates', TemplateViewSet)
router.register(r'notifications', NotificationViewSet, basename='notification')
router.register(r'commissions', CommissionViewSet)
router.register(r'refunds', RefundViewSet)
router.register(r'lead-sources', LeadSourceViewSet)
router.register(r'visa-tracking', VisaTrackingViewSet)
router.register(r'follow-ups', FollowUpViewSet)

# New endpoints
router.register(r'agents', AgentViewSet)
router.register(r'chat-conversations', ChatConversationViewSet)
router.register(r'chat-messages', ChatMessageViewSet)
router.register(r'group-chats', GroupChatViewSet)
router.register(r'signup-requests', SignupRequestViewSet)
router.register(r'approval-requests', ApprovalRequestViewSet)

urlpatterns = [
    path('', include(router.urls)),
]
