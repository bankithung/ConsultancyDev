'use client';

import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Intake editor for ORIGINAL PAPER the office is taking into custody.
 *
 * Collects only what `apiClient.studentDocuments.create` accepts — there is no
 * file here. Uploading a scan is a different thing entirely; use
 * `DocumentUpload`.
 *
 * Controlled rather than bound to react-hook-form: the row shape is fixed, and
 * a plain `value`/`onChange` pair works from `useState`, from a `<Controller>`,
 * or from a reducer without any generic gymnastics. To drive it from
 * react-hook-form:
 *
 * ```tsx
 * <Controller
 *   control={control}
 *   name="student_documents"
 *   render={({ field }) => (
 *     <DocumentTakeover value={field.value} onChange={field.onChange} />
 *   )}
 * />
 * ```
 */

/** One row. Field names match `StudentDocumentInput` so a caller can spread it. */
export interface PhysicalDocumentDraft {
  name: string;
  document_number: string;
  remarks: string;
}

export function blankPhysicalDocument(): PhysicalDocumentDraft {
  return { name: '', document_number: '', remarks: '' };
}

/**
 * Rows worth sending. A row with no name is an empty form line the user never
 * filled in, not a document — saving it would create a nameless record.
 */
export function usablePhysicalDocuments(rows: PhysicalDocumentDraft[]): PhysicalDocumentDraft[] {
  return rows.filter((row) => row.name.trim() !== '');
}

/** Suggestions only — the field stays free text, since this list is never complete. */
const COMMON_DOCUMENTS = [
  'Class 10 Marksheet',
  'Class 10 Passing Certificate',
  'Class 12 Marksheet',
  'Class 12 Passing Certificate',
  'Admit Card (10th/12th)',
  'Migration Certificate',
  'Transfer Certificate (TC)',
  'Character Certificate',
  'Aadhaar Card',
  'PAN Card',
  'Passport',
  'NEET Score Card',
  'Gap Certificate',
  'Domicile Certificate',
  'Caste Certificate',
  'Income Certificate',
  'Passport Size Photos',
] as const;

interface DocumentTakeoverProps {
  value: PhysicalDocumentDraft[];
  onChange: (rows: PhysicalDocumentDraft[]) => void;
  disabled?: boolean;
  /** Drops the enable/disable checkbox, for hosts that always collect originals. */
  alwaysOpen?: boolean;
}

export function DocumentTakeover({
  value,
  onChange,
  disabled = false,
  alwaysOpen = false,
}: DocumentTakeoverProps) {
  const fieldId = useId();
  const [enabled, setEnabled] = useState(false);

  // Derived rather than stored, so rows arriving later (an async edit form)
  // open the section without an effect that fights the user's own toggle.
  const open = alwaysOpen || enabled || value.length > 0;

  const toggle = (next: boolean) => {
    setEnabled(next);
    if (next && value.length === 0) {
      onChange([blankPhysicalDocument()]);
      return;
    }
    // Collapsing clears the rows on purpose: what is on screen is exactly what
    // gets saved. Leaving hidden rows behind is how a "cancelled" takeover ends
    // up creating custody records nobody meant to create.
    if (!next) onChange([]);
  };

  const updateRow = (index: number, patch: Partial<PhysicalDocumentDraft>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
      {!alwaysOpen && (
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={`${fieldId}-toggle`}
            checked={open}
            disabled={disabled}
            onCheckedChange={(checked) => toggle(checked === true)}
            className="mt-0.5"
          />
          <Label
            htmlFor={`${fieldId}-toggle`}
            className="cursor-pointer select-none text-sm font-medium text-slate-900"
          >
            Document takeover
            <span className="mt-0.5 block text-xs font-normal text-slate-500">
              The office is holding the student&rsquo;s original papers
            </span>
          </Label>
        </div>
      )}

      {open && (
        <div className="space-y-2 border-slate-200 sm:border-l-2 sm:pl-4">
          <p className="text-xs text-slate-500">
            List each original being handed in. Only the name is required.
          </p>

          {value.length > 0 && (
            <div className="mb-1 hidden grid-cols-12 gap-3 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:grid">
              <div className="col-span-4">Document name</div>
              <div className="col-span-3">ID / number</div>
              <div className="col-span-4">Remarks</div>
              <div className="col-span-1" />
            </div>
          )}

          {value.map((row, index) => (
            <div
              key={index}
              className="grid grid-cols-1 items-start gap-2 rounded-md border border-slate-200 bg-white p-2 shadow-sm md:grid-cols-12 md:items-center"
            >
              <div className="md:col-span-4">
                <Label
                  htmlFor={`${fieldId}-name-${index}`}
                  className="mb-1 block text-[10px] text-slate-400 md:hidden"
                >
                  Document name
                </Label>
                <Input
                  id={`${fieldId}-name-${index}`}
                  list={`${fieldId}-options`}
                  value={row.name}
                  disabled={disabled}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  placeholder="Select or type…"
                  className="h-9 text-sm"
                />
              </div>

              <div className="md:col-span-3">
                <Label
                  htmlFor={`${fieldId}-number-${index}`}
                  className="mb-1 block text-[10px] text-slate-400 md:hidden"
                >
                  ID / number
                </Label>
                <Input
                  id={`${fieldId}-number-${index}`}
                  value={row.document_number}
                  disabled={disabled}
                  onChange={(e) => updateRow(index, { document_number: e.target.value })}
                  placeholder="e.g. A1234567"
                  className="h-9 text-sm"
                />
              </div>

              <div className="md:col-span-4">
                <Label
                  htmlFor={`${fieldId}-remarks-${index}`}
                  className="mb-1 block text-[10px] text-slate-400 md:hidden"
                >
                  Remarks
                </Label>
                <Input
                  id={`${fieldId}-remarks-${index}`}
                  value={row.remarks}
                  disabled={disabled}
                  onChange={(e) => updateRow(index, { remarks: e.target.value })}
                  placeholder="Condition, copies handed back…"
                  className="h-9 text-sm"
                />
              </div>

              <div className="flex justify-end md:col-span-1 md:justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={`Remove ${row.name.trim() || `row ${index + 1}`}`}
                  className="h-8 w-8 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  onClick={() => removeRow(index)}
                >
                  <X size={14} />
                </Button>
              </div>
            </div>
          ))}

          <datalist id={`${fieldId}-options`}>
            {COMMON_DOCUMENTS.map((doc) => (
              <option key={doc} value={doc} />
            ))}
          </datalist>

          {value.length === 0 && (
            <p className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-4 text-center text-xs text-slate-500">
              No originals listed yet.
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...value, blankPhysicalDocument()])}
            className="mt-2 border-teal-200 text-teal-700 hover:bg-teal-50"
          >
            <Plus size={14} className="mr-1" /> Add document
          </Button>
        </div>
      )}
    </div>
  );
}
