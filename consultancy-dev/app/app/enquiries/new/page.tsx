'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { EnquiryForm } from '../components/EnquiryForm';
import { BackButton } from '@/components/ui/back-button';

export default function NewEnquiryPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: apiClient.enquiries.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      router.push('/app/enquiries');
    },
  });

  return (
    <div className="max-w-3xl mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <BackButton />
          <h1 className="text-2xl font-bold text-slate-900 mt-2">New Enquiry</h1>
          <p className="text-sm text-slate-600 mt-1">Fill in the details below to create a new student enquiry</p>
        </div>
      </div>
      
      <EnquiryForm 
        onSubmit={(data) => mutation.mutate(data)} 
        isLoading={mutation.isPending} 
      />
    </div>
  );
}
