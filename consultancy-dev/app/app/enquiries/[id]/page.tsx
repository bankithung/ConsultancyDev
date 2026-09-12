'use client';

import { useRouter, useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, type EnquiryInput } from '@/lib/apiClient';
import { createApprovalRequest } from '@/components/common/approvals';
import { EnquiryForm } from '../components/EnquiryForm';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/ui/back-button';
import { ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { toast } from '@/store/toastStore';

export default function EnquiryDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { user } = useAuthStore();

  const { data: enquiry, isLoading } = useQuery({
    queryKey: ['enquiry', id],
    queryFn: () => apiClient.enquiries.get(id),
  });

  // Mutation for creating approval request (employees)
  const approvalMutation = useMutation({
    mutationFn: async (data: EnquiryInput) => {
      if (!enquiry) return;
      await createApprovalRequest({
        action: 'UPDATE',
        entity_type: 'enquiry',
        entity_id: Number(id),
        entity_name: enquiry.candidateName,
        message: 'Request to update enquiry details',
        pending_changes: { ...data },
      });
    },
    onSuccess: () => {
      toast.success('Update request sent to admin for approval');
      router.push('/app/enquiries');
    },
    onError: (error) => {
      console.error('Failed to create approval request', error);
      toast.error('Failed to send update request');
    },
  });

  // Mutation for direct update (admins)
  const updateMutation = useMutation({
    mutationFn: async (data: EnquiryInput) => {
      return apiClient.enquiries.update(id, data);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['enquiry', id], saved);
      queryClient.invalidateQueries({ queryKey: ['student-profile'] });
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      toast.success('Enquiry updated successfully');
      router.push('/app/enquiries');
    },
    onError: (error) => {
      console.error('Failed to update enquiry', error);
      toast.error('Failed to update enquiry');
    },
  });

  const handleSubmit = (data: EnquiryInput) => {
    // Check user role and route appropriately
    if (user?.role === 'EMPLOYEE') {
      approvalMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  if (isLoading) return <div className="flex items-center justify-center min-h-screen"><div className="animate-pulse text-slate-500">Loading...</div></div>;
  if (!enquiry) return <div className="p-8 text-center text-slate-500">Enquiry not found</div>;

  return (
    <div className="max-w-3xl mx-auto py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-2">
          <BackButton />
          <h1 className="text-2xl font-bold text-slate-900">Enquiry Details</h1>
          <p className="text-sm text-slate-600">
            {user?.role === 'EMPLOYEE'
              ? 'Submit changes for admin approval'
              : 'View and update enquiry information'}
          </p>
        </div>
        <Button
          className="bg-green-600 hover:bg-green-700 h-10 font-semibold"
          onClick={() => router.push(`/app/registrations/new?enquiryId=${id}`)}
        >
          Convert to Registration <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <EnquiryForm
        initialData={enquiry}
        onSubmit={handleSubmit}
        isLoading={updateMutation.isPending || approvalMutation.isPending}
        submitError={updateMutation.error || approvalMutation.error}
      />
    </div>
  );
}
