'use client';

import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { StudentDocument, StudentDocumentInput, StudentDocumentStatus } from '@/lib/types';
import { toArray } from '@/components/common/pagination';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';

const DOCUMENT_STATUSES: readonly StudentDocumentStatus[] = [
  'Received',
  'With staff',
  'Submitted',
  'Returned',
  'Lost',
];

/** No `.coerce`/`.default` anywhere, so `z.input` === `z.output` and the resolver's generics line up. */
const documentSchema = z.object({
  name: z.string().min(1, 'Document name is required'),
  documentNumber: z.string(),
  status: z.enum(['Received', 'With staff', 'Submitted', 'Returned', 'Lost']),
  remarks: z.string(),
  /** User id as a string; `''` means nobody is holding it. */
  currentHolder: z.string(),
});

type DocumentFormValues = z.infer<typeof documentSchema>;

const EMPTY_FORM: DocumentFormValues = {
  name: '',
  documentNumber: '',
  status: 'Received',
  remarks: '',
  currentHolder: '',
};

interface PhysicalDocumentModalProps {
  open: boolean;
  onClose: () => void;
  registrationId: string;
  /** Null to create, a record to edit. */
  document: StudentDocument | null;
  onSaved: () => void;
}

export function PhysicalDocumentModal({
  open,
  onClose,
  registrationId,
  document,
  onSaved,
}: PhysicalDocumentModalProps) {
  const queryClient = useQueryClient();
  const isEdit = document !== null;

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DocumentFormValues>({
    resolver: zodResolver(documentSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (!open) return;
    reset(
      document
        ? {
            name: document.name,
            documentNumber: document.document_number ?? '',
            status: document.status,
            remarks: document.remarks ?? '',
            currentHolder: document.current_holder === null ? '' : String(document.current_holder),
          }
        : EMPTY_FORM,
    );
  }, [open, document, reset]);

  // Staff who could be holding the paper. Capped at the server's page_size
  // ceiling; a consultancy branch never has more colleagues than that.
  const staffQuery = useQuery({
    queryKey: ['users', 'document-holders'],
    queryFn: () => apiClient.users.list({ page_size: 200, ordering: 'first_name' }),
    enabled: open,
  });
  const staff = toArray(staffQuery.data);

  const saveMutation = useMutation({
    mutationFn: (values: DocumentFormValues) => {
      const payload: StudentDocumentInput = {
        registration: registrationId,
        name: values.name.trim(),
        document_number: values.documentNumber.trim(),
        status: values.status,
        remarks: values.remarks.trim(),
        current_holder: values.currentHolder === '' ? null : Number(values.currentHolder),
      };

      return document
        ? apiClient.studentDocuments.update(document.id, payload)
        : apiClient.studentDocuments.create(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student-documents', registrationId] });
      onSaved();
      onClose();
      toast.success(isEdit ? 'Document record updated' : 'Document recorded');
    },
  });

  const onSubmit = handleSubmit((values) => saveMutation.mutate(values));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit document record' : 'Record an original document'}
      description="Tracks a physical paper the office is holding. Uploaded scans go under the Digital tab."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="h-10" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="physical-document-form" className="h-10" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <>
                <InlineSpinner className="mr-2" /> Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      }
    >
      <form id="physical-document-form" onSubmit={onSubmit} className="space-y-4">
        {saveMutation.isError && <ErrorBanner error={saveMutation.error} />}

        <div className="space-y-1.5">
          <Label htmlFor="doc-name">
            Document <span className="text-red-500">*</span>
          </Label>
          <Input id="doc-name" placeholder="e.g. Original passport" className="h-10" {...register('name')} />
          {errors.name && <p className="text-xs text-red-600">{errors.name.message}</p>}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="doc-number">Reference number</Label>
            <Input id="doc-number" placeholder="Optional" className="h-10" {...register('documentNumber')} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-status">Status</Label>
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="doc-status" className="h-10 w-full bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="doc-holder">Currently held by</Label>
          <Controller
            name="currentHolder"
            control={control}
            render={({ field }) => (
              <Select value={field.value === '' ? 'none' : field.value} onValueChange={(next) => field.onChange(next === 'none' ? '' : next)}>
                <SelectTrigger id="doc-holder" className="h-10 w-full bg-white">
                  <SelectValue placeholder="Nobody assigned" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  <SelectItem value="none">Nobody assigned</SelectItem>
                  {staff.map((member) => (
                    <SelectItem key={member.id} value={String(member.id)}>
                      {member.full_name || member.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {staffQuery.isError && <p className="text-xs text-amber-700">Could not load colleagues — leave unassigned for now.</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="doc-remarks">Remarks</Label>
          <Textarea id="doc-remarks" placeholder="Where it is filed, condition, anything worth noting" {...register('remarks')} />
        </div>
      </form>
    </Modal>
  );
}
