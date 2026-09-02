from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenRefreshView

from . import analytics
from .views import (
    AgentViewSet, ApiKeyViewSet, AppointmentViewSet, ApprovalRequestViewSet,
    BranchViewSet,
    CommissionViewSet, CompanyViewSet, DocumentViewSet, EnquiryViewSet,
    FollowUpCommentViewSet,
    EnrollmentViewSet, FollowUpViewSet, HealthView, InstallmentViewSet,
    LoginView, LogoutView, MyCapabilitiesView,
    NotificationViewSet,
    PaymentViewSet, PlanViewSet, RecordTransferViewSet, RefundViewSet,
    RegistrationViewSet, RolePermissionView, SignupRequestViewSet,
    StudentDocumentViewSet,
    StudentRemarkViewSet, SubscriptionViewSet, TaskViewSet, TemplateViewSet,
    UniversityViewSet, UserViewSet, VisaTrackingViewSet,
)

router = DefaultRouter()

# Tenancy and billing
router.register(r'companies', CompanyViewSet, basename='company')
router.register(r'branches', BranchViewSet, basename='branch')
router.register(r'plans', PlanViewSet, basename='plan')
router.register(r'subscriptions', SubscriptionViewSet, basename='subscription')

# People
router.register(r'users', UserViewSet, basename='user')
router.register(r'api-keys', ApiKeyViewSet, basename='apikey')

# CRM
router.register(r'enquiries', EnquiryViewSet, basename='enquiry')
router.register(r'registrations', RegistrationViewSet, basename='registration')
router.register(r'enrollments', EnrollmentViewSet, basename='enrollment')
router.register(r'installments', InstallmentViewSet, basename='installment')
router.register(r'payments', PaymentViewSet, basename='payment')
router.register(r'documents', DocumentViewSet, basename='document')
router.register(r'tasks', TaskViewSet, basename='task')
router.register(r'appointments', AppointmentViewSet, basename='appointment')
router.register(r'universities', UniversityViewSet, basename='university')
router.register(r'templates', TemplateViewSet, basename='template')
router.register(r'notifications', NotificationViewSet, basename='notification')
router.register(r'agents', AgentViewSet, basename='agent')
router.register(r'commissions', CommissionViewSet, basename='commission')
router.register(r'refunds', RefundViewSet, basename='refund')
router.register(r'visa-tracking', VisaTrackingViewSet, basename='visatracking')
router.register(r'follow-ups', FollowUpViewSet, basename='followup')

# Student file: running commentary, and custody of original paper documents.
router.register(r'follow-up-comments', FollowUpCommentViewSet, basename='followupcomment')
router.register(r'student-remarks', StudentRemarkViewSet, basename='studentremark')
router.register(r'student-documents', StudentDocumentViewSet, basename='studentdocument')

# Workflow
router.register(r'transfers', RecordTransferViewSet, basename='transfer')
router.register(r'signup-requests', SignupRequestViewSet, basename='signuprequest')
router.register(r'approval-requests', ApprovalRequestViewSet, basename='approvalrequest')

urlpatterns = [
    # Auth
    path('auth/login/', LoginView.as_view(), name='login'),
    path('auth/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('auth/logout/', LogoutView.as_view(), name='logout'),

    # Role permissions.
    #
    # Explicit paths rather than a router registration: the grid is ONE
    # resource — roles x capabilities for a company — not a collection of rows,
    # and a viewset would have made the screen issue a request per cell.
    path('role-permissions/', RolePermissionView.as_view(), name='role-permissions'),
    path('role-permissions/mine/', MyCapabilitiesView.as_view(), name='my-capabilities'),

    # Analytics
    path('analytics/overview/', analytics.OverviewAnalytics.as_view()),
    path('analytics/funnel/', analytics.FunnelAnalytics.as_view()),
    path('analytics/revenue/', analytics.RevenueAnalytics.as_view()),
    path('analytics/branches/', analytics.BranchAnalytics.as_view()),
    path('analytics/visa-pipeline/', analytics.VisaPipelineAnalytics.as_view()),
    path('analytics/sources/', analytics.SourceAnalytics.as_view()),

    path('health/', HealthView.as_view(), name='health'),
    path('', include(router.urls)),
]

