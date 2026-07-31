'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, FileText, X } from 'lucide-react';

import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { usablePhysicalDocuments } from '@/components/common/DocumentTakeover';
import { RegistrationReceipt } from '@/components/receipts/RegistrationReceipt';
import { toast } from '@/store/toastStore';
import {
  RegistrationForm,
  toProfileDetail,
  toRegistrationWrite,
  type RegistrationFormValues,
} from '../components/RegistrationForm';
import {
  createRegistration,
  describeProfileDetail,
  linkDocumentToRegistration,
  type RegistrationRecord,
} from '../components/wire';

interface CreateOutcome {
  registration: RegistrationRecord;
  /** Originals the API accepted. Fewer than asked for means some rows failed. */
  originalsRecorded: number;
  originalsRequested: number;
  /** Follow-up work that failed after the registration itself was saved. */
  warnings: string[];
}

export default function NewRegistrationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const enquiryId = searchParams.get('enquiryId');

  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);

  const mutation = useMutation<CreateOutcome, unknown, RegistrationFormValues>({
    mutationFn: async (values) => {
      const warnings: string[] = [];

      // 1. The registration itself. Anything that fails here is a hard failure
      //    -- nothing downstream can be attempted without an id.
      const registration = await createRegistration(
        toRegistrationWrite(values, enquiryId ? Number(enquiryId) : null),
      );

      // 2. Originals handed in at the counter. Sent one at a time so a single
      //    bad row does not discard the rest, and the caller is told how many
      //    actually landed rather than how many were asked for.
      const originals = usablePhysicalDocuments(values.student_documents);
      let originalsRecorded = 0;
      for (const original of originals) {
        try {
          await apiClient.studentDocuments.create({
            registration: registration.id,
            name: original.name.trim(),
            document_number: original.document_number.trim(),
            remarks: original.remarks.trim(),
          });
          originalsRecorded += 1;
        } catch (error) {
          warnings.push(`Could not record “${original.name}”: ${getApiErrorMessage(error)}`);
        }
      }

      // 3. Everything the model has no column for, kept as one dated note on
      //    the student's file. See `ProfileDetail` for why.
      const profileNote = describeProfileDetail(toProfileDetail(values));
      if (profileNote) {
        try {
          await apiClient.studentRemarks.create({
            registration: registration.id,
            remark: profileNote,
          });
        } catch (error) {
          warnings.push(
            `The academic and personal profile could not be saved to the remarks log: ${getApiErrorMessage(error)}`,
          );
        }
      }

      // 4. Link the scans uploaded during the form to this registration. The
      //    upload widget files them by student name because the registration
      //    did not exist yet; now it does.
      for (const document of values.documents) {
        try {
          await linkDocumentToRegistration(document.id, registration.id);
        } catch (error) {
          warnings.push(`Could not link “${document.fileName}”: ${getApiErrorMessage(error)}`);
        }
      }

      return {
        registration,
        originalsRecorded,
        originalsRequested: originals.length,
        warnings,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['registrations'] });
      queryClient.invalidateQueries({ queryKey: ['enquiries'] });
      queryClient.invalidateQueries({ queryKey: ['student-remarks'] });
      queryClient.invalidateQueries({ queryKey: ['student-documents'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-weekly'] });

      setOutcome(result);
      setShowSuccessModal(true);
      toast.success('Registration created', result.registration.registrationNo);
    },
    onError: (error) => {
      toast.error('Could not create the registration', getApiErrorMessage(error));
    },
  });

  const handleClose = () => {
    setShowSuccessModal(false);
    setShowReceipt(false);
    router.push('/app/registrations');
  };

  const registration = outcome?.registration;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <RegistrationForm
        onSubmit={(values) => mutation.mutate(values)}
        isLoading={mutation.isPending}
        enquiryId={enquiryId}
        submitError={mutation.isError ? mutation.error : undefined}
      />

      {/* Success -------------------------------------------------------- */}
      <Dialog.Root open={showSuccessModal} onOpenChange={handleClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] z-50 max-h-[85vh] w-[92vw] max-w-[450px] translate-x-[-50%] translate-y-[-50%] overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-xl focus:outline-none">
            <Dialog.Title className="mb-2 text-xl font-bold text-slate-900">
              Registration Successful
            </Dialog.Title>
            <Dialog.Description className="mb-4 text-sm text-slate-600">
              Created with number{' '}
              <span className="font-mono font-bold text-slate-900">
                {registration?.registrationNo}
              </span>
              .
            </Dialog.Description>

            {outcome && outcome.originalsRequested > 0 && (
              <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                Recorded <span className="font-semibold">{outcome.originalsRecorded}</span> of{' '}
                {outcome.originalsRequested} original document
                {outcome.originalsRequested === 1 ? '' : 's'} into custody.
              </p>
            )}

            {outcome && outcome.warnings.length > 0 && (
              <div className="mb-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                  <AlertTriangle size={14} /> The registration saved, but:
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
                  {outcome.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <Button
                className="h-11 w-full bg-teal-600 hover:bg-teal-700"
                onClick={() => {
                  setShowSuccessModal(false);
                  setShowReceipt(true);
                }}
              >
                <FileText className="mr-2 h-4 w-4" /> Print Receipt
              </Button>
              <Button variant="outline" className="h-11 w-full" onClick={handleClose}>
                Close &amp; Go to List
              </Button>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="absolute right-4 top-4 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={20} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Receipt -------------------------------------------------------- */}
      {showReceipt && registration && (
        <RegistrationReceipt
          data={{
            registrationNo: registration.registrationNo,
            studentName: registration.studentName,
            email: registration.email,
            mobile: registration.mobile,
            dateOfBirth: registration.date_of_birth ?? undefined,
            fatherName: registration.fatherName,
            motherName: registration.motherName,
            permanentAddress: registration.permanentAddress,
            registrationFee: registration.registrationFee,
            paymentMethod: registration.paymentMethod,
            paymentStatus: registration.paymentStatus,
            preferences: registration.preferences,
            createdAt: registration.registrationDate,
          }}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
