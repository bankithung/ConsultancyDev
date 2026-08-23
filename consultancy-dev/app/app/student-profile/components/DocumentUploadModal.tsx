'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';

/** Free text on the wire; this list keeps the values consistent across staff. */
const DOCUMENT_TYPES = [
  'Passport',
  'Class 10 Marksheet',
  'Class 12 Marksheet',
  'Transfer Certificate',
  'Migration Certificate',
  'NEET Scorecard',
  'Photograph',
  'Aadhaar',
  'Offer Letter',
  'Other',
] as const;

interface DocumentUploadModalProps {
  open: boolean;
  onClose: () => void;
  studentName: string;
  registrationNo?: string;
  /**
   * The record to attach the upload to. `registrationNo` is a human
   * reference, not a key -- it cannot link anything on its own.
   */
  registrationId?: string;
  enquiryId?: string;
}

/**
 * Multipart upload of a scan.
 *
 * Deliberately not react-hook-form: the payload is a `File` plus three scalars,
 * and RHF's uncontrolled file handling buys nothing here.
 */
export function DocumentUploadModal({
  open,
  onClose,
  studentName,
  registrationNo,
  registrationId,
  enquiryId,
}: DocumentUploadModalProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<string>(DOCUMENT_TYPES[0]);
  const [expiryDate, setExpiryDate] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setType(DOCUMENT_TYPES[0]);
    setExpiryDate('');
    setValidationError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open]);

  const uploadMutation = useMutation({
    mutationFn: (chosen: File) =>
      apiClient.documents.upload({
        file: chosen,
        type,
        // Prefer the registration: it is the record documents hang off once a
        // student has one. The enquiry link covers the stage before that.
        registration: registrationId,
        enquiry: registrationId ? undefined : enquiryId,
        expiryDate: expiryDate || undefined,
        status: 'IN',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      toast.success('Document uploaded');
      onClose();
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setValidationError('Choose a file to upload.');
      return;
    }
    setValidationError(null);
    uploadMutation.mutate(file);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Upload document"
      description={registrationNo ? `Filed against ${registrationNo}` : `Filed against ${studentName}`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="h-10" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="document-upload-form" className="h-10" disabled={uploadMutation.isPending}>
            {uploadMutation.isPending ? (
              <>
                <InlineSpinner className="mr-2" /> Uploading…
              </>
            ) : (
              <>
                <UploadCloud size={16} className="mr-2" /> Upload
              </>
            )}
          </Button>
        </div>
      }
    >
      <form id="document-upload-form" onSubmit={handleSubmit} className="space-y-4">
        {uploadMutation.isError && <ErrorBanner error={uploadMutation.error} />}
        {validationError && <ErrorBanner error={validationError} />}

        <div className="space-y-1.5">
          <Label htmlFor="upload-file">
            File <span className="text-red-500">*</span>
          </Label>
          <Input
            id="upload-file"
            ref={fileInputRef}
            type="file"
            className="h-auto py-2"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setValidationError(null);
            }}
          />
          {file && (
            <p className="text-xs text-slate-500">
              {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="upload-type">Document type</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="upload-type" className="h-10 w-full bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-60">
              {DOCUMENT_TYPES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="upload-expiry">Expiry date</Label>
          <Input
            id="upload-expiry"
            type="date"
            className="h-10"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
          />
          <p className="text-xs text-slate-500">Optional — used by the expiring-documents report.</p>
        </div>
      </form>
    </Modal>
  );
}
