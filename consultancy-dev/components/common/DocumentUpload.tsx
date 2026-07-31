'use client';

import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Download, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBanner, InlineSpinner, SuccessBanner } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { getApiErrorMessage } from '@/lib/api';
import type { Document } from '@/lib/types';

/**
 * Staging area for UPLOADED SCANS (`apiClient.documents`).
 *
 * These are real files: the binary is posted as multipart, encrypted at rest by
 * the server, and read back through `documents/{id}/download/`. Nothing here
 * tracks the paper original — that is `apiClient.studentDocuments`, edited from
 * `DocumentTakeover` / `PhysicalDocumentModal`.
 */

const DOC_TYPES = ['General', 'Marksheet', 'ID Proof', 'Passport', 'Certificate', 'Offer Letter', 'Visa'] as const;

/** Matches the ceiling advertised on the drop zone, and the one the API enforces. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

let stagedKeySeed = 0;

type StagedStatus = 'pending' | 'done' | 'error';

interface StagedFile {
  key: string;
  file: File;
  type: string;
  expiryDate: string;
  status: StagedStatus;
  error?: string;
  /** Set once the API has the file, enabling download. */
  documentId?: string;
}

export function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DocumentUploadProps {
  /** Stamped on every upload. When omitted the component asks for it. */
  studentName?: string;
  /** `card` renders its own panel; `minimal` is for embedding in a form step. */
  variant?: 'card' | 'minimal';
  readOnly?: boolean;
  /** Called with the documents the API accepted. */
  onUploaded?: (documents: Document[]) => void;
}

// There is deliberately no `registrationNo` prop. `DocumentSerializer` exposes
// `registration` (an FK id) and has no `registration_no` field at all, so the
// `registration_no` that `apiClient.documents.upload` currently sends is
// discarded by DRF without error. Accepting the prop here would look like it
// linked the upload to a student when it did not. Once `upload` takes a
// `registration` id, add it back.

export function DocumentUpload({
  studentName,
  variant = 'card',
  readOnly = false,
  onUploaded,
}: DocumentUploadProps) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [ownerName, setOwnerName] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  // A prop wins over the local field, so a profile page never asks again for a
  // name it already knows.
  const owner = studentName ?? (ownerName.trim() || undefined);
  const pending = staged.filter((item) => item.status !== 'done');

  const patchStaged = (key: string, patch: Partial<StagedFile>) => {
    setStaged((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadedCount(0);

    const accepted: StagedFile[] = [];
    const tooLarge: string[] = [];

    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        tooLarge.push(`“${file.name}” is ${formatFileSize(file.size)} — the limit is 10 MB.`);
        continue;
      }
      stagedKeySeed += 1;
      accepted.push({
        key: `staged-${stagedKeySeed}`,
        file,
        type: 'General',
        expiryDate: '',
        status: 'pending',
      });
    }

    setRejected(tooLarge);
    if (accepted.length > 0) setStaged((current) => [...current, ...accepted]);

    // Lets the same file be picked again after it is removed.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploadMutation = useMutation<Document[], Error, StagedFile[]>({
    // Sequential on purpose: the files are large and multipart, and a serial
    // loop lets each row flip to done or error as it lands rather than the
    // whole batch resolving at once.
    mutationFn: async (queue) => {
      const uploaded: Document[] = [];

      for (const item of queue) {
        try {
          const document = await apiClient.documents.upload({
            file: item.file,
            type: item.type,
            studentName: owner,
            expiryDate: item.expiryDate || undefined,
          });
          uploaded.push(document);
          patchStaged(item.key, { status: 'done', documentId: document.id, error: undefined });
        } catch (error) {
          patchStaged(item.key, { status: 'error', error: getApiErrorMessage(error) });
        }
      }

      return uploaded;
    },
    onSuccess: (uploaded) => {
      if (uploaded.length === 0) return;
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['documents-expiring'] });
      setUploadedCount(uploaded.length);
      onUploaded?.(uploaded);
    },
  });

  const downloadMutation = useMutation({
    mutationFn: ({ item }: { item: StagedFile }) => {
      if (!item.documentId) throw new Error('This file has not been uploaded yet.');
      return apiClient.documents.downloadAndSave(item.documentId, item.file.name);
    },
    onSettled: () => setDownloadingKey(null),
  });

  const failedCount = staged.filter((item) => item.status === 'error').length;

  const controls = (
    <div className="flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        id={`${fieldId}-files`}
        aria-label="Choose files to upload"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {studentName === undefined && (
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-owner`} className="font-medium text-slate-700">
            Student name <span className="font-normal text-slate-400">(optional)</span>
          </Label>
          <Input
            id={`${fieldId}-owner`}
            className="h-11"
            placeholder="Who do these belong to?"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
          />
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        className="flex h-auto w-full flex-row items-center justify-center gap-3 rounded-xl border-2 border-dashed border-teal-600/30 bg-teal-50/30 py-3 text-teal-700 transition-all hover:bg-teal-50 hover:text-teal-800"
        onClick={() => fileInputRef.current?.click()}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-600">
          <Plus size={16} />
        </span>
        <span className="flex min-w-0 flex-col items-start">
          <span className="text-sm font-bold">Add documents</span>
          <span className="text-[10px] opacity-70">PDF, DOC, JPG, PNG up to 10 MB each</span>
        </span>
      </Button>

      {pending.length > 0 && (
        <Button
          type="button"
          className="h-11 w-full rounded-xl bg-teal-600 font-bold text-white hover:bg-teal-700"
          disabled={uploadMutation.isPending}
          onClick={() => uploadMutation.mutate(pending)}
        >
          {uploadMutation.isPending ? (
            <>
              <InlineSpinner className="mr-2" /> Uploading…
            </>
          ) : (
            <>
              <Upload size={16} className="mr-2" />
              Upload {pending.length} file{pending.length === 1 ? '' : 's'}
            </>
          )}
        </Button>
      )}
    </div>
  );

  const list = (
    <div className="space-y-2">
      {staged.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-300">
            <FileText size={24} />
          </span>
          <p className="text-sm font-medium text-slate-400">No documents attached</p>
        </div>
      ) : (
        staged.map((item) => (
          <div
            key={item.key}
            className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 transition-all hover:border-teal-100 sm:flex-row sm:items-start"
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                item.status === 'done'
                  ? 'bg-green-50 text-green-600'
                  : item.status === 'error'
                    ? 'bg-red-50 text-red-600'
                    : 'bg-slate-50 text-slate-400'
              }`}
            >
              {item.status === 'done' ? (
                <CheckCircle2 size={16} />
              ) : item.status === 'error' ? (
                <AlertCircle size={16} />
              ) : (
                <FileText size={16} />
              )}
            </span>

            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 break-all text-xs font-bold text-slate-800" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="shrink-0 rounded bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {formatFileSize(item.file.size)}
                </span>
              </div>

              {item.status === 'pending' && !readOnly ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${item.key}-type`} className="text-[10px] uppercase text-slate-400">
                      Type
                    </Label>
                    <Select
                      value={item.type}
                      onValueChange={(value) => patchStaged(item.key, { type: value })}
                    >
                      <SelectTrigger id={`${item.key}-type`} className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DOC_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${item.key}-expiry`} className="text-[10px] uppercase text-slate-400">
                      Expiry <span className="normal-case">(optional)</span>
                    </Label>
                    <Input
                      id={`${item.key}-expiry`}
                      type="date"
                      className="h-9 text-xs"
                      value={item.expiryDate}
                      onChange={(e) => patchStaged(item.key, { expiryDate: e.target.value })}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-[11px] font-medium text-slate-500">
                  {item.type}
                  {item.expiryDate ? ` · expires ${item.expiryDate}` : ''}
                  {item.status === 'done' ? ' · uploaded' : ''}
                </p>
              )}

              {item.status === 'error' && item.error && (
                <p className="break-words text-[11px] text-red-600">{item.error}</p>
              )}
            </div>

            <div className="flex shrink-0 gap-1 sm:flex-col">
              {item.documentId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:bg-teal-50 hover:text-teal-600"
                  aria-label={`Download ${item.file.name}`}
                  disabled={downloadingKey === item.key}
                  onClick={() => {
                    setDownloadingKey(item.key);
                    downloadMutation.mutate({ item });
                  }}
                >
                  {downloadingKey === item.key ? <InlineSpinner /> : <Download size={14} />}
                </Button>
              )}

              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label={
                    item.status === 'done'
                      ? `Remove ${item.file.name} from this list`
                      : `Remove ${item.file.name}`
                  }
                  disabled={uploadMutation.isPending}
                  onClick={() => setStaged((current) => current.filter((row) => row.key !== item.key))}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );

  const banners = (
    <div className="space-y-2">
      {rejected.length > 0 && (
        <ErrorBanner error={rejected.join(' ')} onDismiss={() => setRejected([])} />
      )}
      {uploadMutation.isError && <ErrorBanner error={uploadMutation.error} />}
      {downloadMutation.isError && (
        <ErrorBanner error={downloadMutation.error} onDismiss={() => downloadMutation.reset()} />
      )}
      {failedCount > 0 && !uploadMutation.isPending && (
        <ErrorBanner
          error={`${failedCount} file${failedCount === 1 ? '' : 's'} failed to upload. Fix the problem and press upload again — the ones that succeeded will not be sent twice.`}
        />
      )}
      {uploadedCount > 0 && (
        <SuccessBanner
          message={`Uploaded ${uploadedCount} document${uploadedCount === 1 ? '' : 's'}.`}
          onDismiss={() => setUploadedCount(0)}
        />
      )}
    </div>
  );

  if (variant === 'minimal') {
    return (
      <div className="space-y-3">
        {banners}
        {!readOnly && controls}
        {list}
      </div>
    );
  }

  return (
    <Card className="overflow-hidden rounded-xl border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-slate-50/50 py-4">
        <CardTitle className="text-sm font-bold uppercase tracking-widest text-slate-700">
          Document upload
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-4">
        {banners}
        {!readOnly && controls}
        <div className="space-y-3">
          <h4 className="pl-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">
            Attached files
          </h4>
          {list}
        </div>
      </CardContent>
    </Card>
  );
}
