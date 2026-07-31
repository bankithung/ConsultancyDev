import type { StudentDocument, StudentDocumentStatus } from '@/lib/types';

/**
 * Shared vocabulary for CUSTODY OF ORIGINAL PAPER (`apiClient.studentDocuments`).
 *
 * Nothing here touches `apiClient.documents` — that resource is uploaded scans
 * with real file content, a separate concept with its own statuses (IN/OUT).
 */

export const PHYSICAL_STATUSES: readonly StudentDocumentStatus[] = [
  'Received',
  'With staff',
  'Submitted',
  'Returned',
  'Lost',
];

/**
 * Statuses where the consultancy is still answerable for the original: it is in
 * a drawer, with a colleague, or lodged with a university. Only these can be
 * handed on or returned — a Returned or Lost original is out of our hands.
 */
export const IN_CUSTODY_STATUSES: readonly StudentDocumentStatus[] = [
  'Received',
  'With staff',
  'Submitted',
];

export function isInCustody(doc: StudentDocument): boolean {
  return IN_CUSTODY_STATUSES.includes(doc.status);
}

export const PHYSICAL_STATUS_STYLE: Record<StudentDocumentStatus, string> = {
  Received: 'bg-blue-100 text-blue-700',
  'With staff': 'bg-amber-100 text-amber-800',
  Submitted: 'bg-indigo-100 text-indigo-700',
  Returned: 'bg-green-100 text-green-700',
  Lost: 'bg-red-100 text-red-700',
};

/** One-line explanation of each status, for tooltips and empty states. */
export const PHYSICAL_STATUS_HINT: Record<StudentDocumentStatus, string> = {
  Received: 'Original is in the office',
  'With staff': 'A colleague is holding the original',
  Submitted: 'Lodged with a university or authority',
  Returned: 'Handed back to the student',
  Lost: 'Cannot be accounted for',
};

/** Dates arrive as ISO strings, but a null or malformed value must not render "Invalid Date". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * Wording for a bulk return.
 *
 * `returnDocs` reports `returned` and `requested` separately: they diverge when
 * an id was outside the caller's scope or was already returned. The message
 * always leads with `returned`, so the UI never claims work it did not do.
 */
export function describeReturn(result: { returned: number; requested: number }): string {
  const { returned, requested } = result;
  if (returned === 0) {
    return requested === 1
      ? 'That original was not returned — it may already be back with the student, or outside what you can act on.'
      : `None of the ${requested} originals were returned. They may already be back with their students, or outside what you can act on.`;
  }
  const noun = returned === 1 ? 'original' : 'originals';
  if (returned < requested) {
    return `Returned ${returned} of ${requested} ${noun}. The rest were already returned or outside what you can act on.`;
  }
  return `Returned ${returned} ${noun} to the student.`;
}

/**
 * Remarks after a hand-over. Intake remarks ("torn corner") are worth keeping,
 * so a note is appended rather than overwriting the field. Returns `undefined`
 * when there is no note, so the caller can omit `remarks` from the PATCH
 * entirely instead of blanking it.
 */
export function appendHandoverNote(
  doc: StudentDocument,
  holderName: string,
  note: string,
): string | undefined {
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  const existing = doc.remarks?.trim();
  const entry = `Handed to ${holderName}: ${trimmed}`;
  return existing ? `${existing}\n${entry}` : entry;
}
