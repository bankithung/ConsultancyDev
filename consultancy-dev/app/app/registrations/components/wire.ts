'use client';

/**
 * Registration writes, plus the profile-detail shaping the shared client does
 * not cover.
 *
 * HISTORY, because the original note here is no longer true: this module was
 * created because `lib/apiClient.ts:toRegistrationPayload` read camelCase keys
 * off a snake_case input, so every field it sent was `undefined`. That has
 * since been fixed centrally — `RegistrationInput` and the payload builder both
 * use the serializer's field names, and the server allocates `registration_no`
 * when omitted.
 *
 * What remains here is genuinely local: the `ProfileDetail` union and its
 * description helper, payment lookup for a student, and the enrolled-ids set.
 * The thin write delegates could now call `apiClient.registrations.*` directly.
 */

import { api } from '@/lib/api';
import { apiClient, fetchAllPages } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import type { Payment, Registration, RegistrationInput, StudyPreference } from '@/lib/types';

/**
 * Names the call sites use. Kept as aliases of the shared types so there is one
 * definition — a parallel copy here is exactly how the camelCase/snake_case
 * drift above started.
 */
export type RegistrationRecord = Registration;
export type RegistrationWrite = RegistrationInput;

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** Raw `RegistrationSerializer` payload, before camelCase remapping. */
interface RawRegistration {
  id: string | number;
  registration_no: string;
  student_name: string;
  mobile: string;
  email: string;
  registration_date: string;
  needs_loan: boolean;
  payment_status: string;
  payment_method: string;
  registration_fee: number | string;
  preferences: StudyPreference[] | null;
  date_of_birth?: string | null;
  father_name: string;
  mother_name: string;
  permanent_address: string;
  enquiry?: number | null;
  enquiry_candidate?: string;
  company?: number | null;
  company_name?: string;
  branch?: number | null;
  branch_name?: string;
  created_by?: number | null;
  created_by_name?: string;
  owner?: number | null;
  owner_name?: string;
  created_at?: string;
  updated_at?: string;
}

function mapRegistration(raw: RawRegistration): Registration {
  return {
    ...raw,
    id: String(raw.id),
    registrationNo: raw.registration_no,
    studentName: raw.student_name,
    registrationDate: raw.registration_date,
    needsLoan: raw.needs_loan,
    paymentStatus: raw.payment_status,
    paymentMethod: raw.payment_method,
    // DecimalFields come off DRF as strings.
    registrationFee: Number(raw.registration_fee ?? 0),
    fatherName: raw.father_name,
    motherName: raw.mother_name,
    permanentAddress: raw.permanent_address,
    preferences: Array.isArray(raw.preferences) ? raw.preferences : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/** `registration_no` is deliberately omitted: the server allocates it under a
 *  row lock, so two simultaneous creates cannot collide. */
export async function createRegistration(input: RegistrationInput): Promise<Registration> {
  const res = await api.post<RawRegistration>('registrations/', input);
  return mapRegistration(res.data);
}

/** PATCH, not PUT -- a tab-by-tab edit must not have to resend every field. */
export async function updateRegistration(
  id: string,
  input: Partial<RegistrationInput>,
): Promise<Registration> {
  const res = await api.patch<RawRegistration>(`registrations/${id}/`, input);
  return mapRegistration(res.data);
}

/**
 * Points an already-uploaded scan at a registration.
 *
 * `DocumentSerializer` exposes a writable `registration` FK, but
 * `apiClient.documents` only patches `status`. Uploads made from the create
 * form are filed by student NAME because the registration does not exist yet;
 * this turns that into a real link. Note the documents endpoint cannot yet
 * FILTER on `registration`, so lists still search by name.
 */
export async function linkDocumentToRegistration(
  documentId: string,
  registrationId: string,
): Promise<void> {
  await api.patch(`documents/${documentId}/`, { registration: Number(registrationId) });
}

/* -------------------------------------------------------------------------- */
/* Related records                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Payments booked against one record.
 *
 * `payments/` has no `registration` or `enrollment` filter -- only
 * status/type/branch/method -- so the endpoint is narrowed by free-text search
 * on the student name and the FK match is made here. Search narrows; the
 * client decides.
 */
export async function paymentsFor(target: {
  studentName: string;
  registrationId?: string;
  enrollmentId?: string;
}): Promise<Payment[]> {
  const name = target.studentName.trim();
  if (name === '') return [];

  const rows = toArray(
    await apiClient.payments.list({ search: name, page_size: 50, ordering: '-date' }),
  );

  if (target.registrationId) {
    return rows.filter((row) => String(row.registration) === String(target.registrationId));
  }
  if (target.enrollmentId) {
    return rows.filter((row) => String(row.enrollment) === String(target.enrollmentId));
  }
  return rows;
}

/**
 * Registration ids that already have an enrollment.
 *
 * Walks every page: from a single page the answer would be "everyone past row
 * 25 is unenrolled", which silently re-offers students who are already placed.
 */
export async function enrolledRegistrationIds(): Promise<Set<string>> {
  const ids = await fetchAllPages<{ student: number | string }, string>(
    'enrollments/',
    (row) => String(row.student),
    { ordering: '-created_at' },
  );
  return new Set(ids);
}

/* -------------------------------------------------------------------------- */
/* Profile detail that has no column on this backend                           */
/* -------------------------------------------------------------------------- */

/**
 * Student detail the form collects that `Registration` has nowhere to put.
 *
 * The model carries name/contact/parents/address/fee/preferences and nothing
 * else -- there is no gender, caste, religion, schooling, marks or gap-year
 * column, on Registration or anywhere adjacent. Rather than discard what the
 * counsellor typed, it is written to the student's remarks log
 * (`apiClient.studentRemarks`), the one place the API keeps free-form detail
 * against a student.
 *
 * That log is append-only and not machine-readable, so this is a record, NOT a
 * round trip: the values do not come back into the form on edit. Anything here
 * needs real columns before it can be filtered, reported on, or corrected.
 */
export interface ProfileDetail {
  gender?: string;
  caste?: string;
  religion?: string;
  fatherOccupation?: string;
  motherOccupation?: string;
  fatherMobile?: string;
  motherMobile?: string;
  familyPlace?: string;
  familyState?: string;
  schoolName?: string;
  schoolBoard?: string;
  schoolPlace?: string;
  schoolState?: string;
  stream?: string;
  class12PassingYear?: string;
  class12Percentage?: number;
  class10SchoolName?: string;
  class10Board?: string;
  class10Place?: string;
  class10State?: string;
  class10PassingYear?: string;
  class10Percentage?: number;
  physicsMarks?: number;
  chemistryMarks?: number;
  biologyMarks?: number;
  mathsMarks?: number;
  pcbPercentage?: number;
  pcmPercentage?: number;
  previousNeetMarks?: number;
  presentNeetMarks?: number;
  gapYear?: boolean;
  gapYearFrom?: number;
  gapYearTo?: number;
  collegeDropout?: boolean;
}

const PROFILE_GROUPS: ReadonlyArray<{
  heading: string;
  rows: ReadonlyArray<readonly [label: string, key: keyof ProfileDetail]>;
}> = [
  {
    heading: 'Personal',
    rows: [
      ['Gender', 'gender'],
      ['Caste', 'caste'],
      ['Religion', 'religion'],
    ],
  },
  {
    heading: 'Family',
    rows: [
      ["Father's occupation", 'fatherOccupation'],
      ["Father's mobile", 'fatherMobile'],
      ["Mother's occupation", 'motherOccupation'],
      ["Mother's mobile", 'motherMobile'],
      ['Family place', 'familyPlace'],
      ['Family state', 'familyState'],
    ],
  },
  {
    heading: 'Class 12 (HSSLC)',
    rows: [
      ['School', 'schoolName'],
      ['Board', 'schoolBoard'],
      ['Place', 'schoolPlace'],
      ['State', 'schoolState'],
      ['Stream', 'stream'],
      ['Passing year', 'class12PassingYear'],
      ['Percentage', 'class12Percentage'],
    ],
  },
  {
    heading: 'Class 10 (HSLC)',
    rows: [
      ['School', 'class10SchoolName'],
      ['Board', 'class10Board'],
      ['Place', 'class10Place'],
      ['State', 'class10State'],
      ['Passing year', 'class10PassingYear'],
      ['Percentage', 'class10Percentage'],
    ],
  },
  {
    heading: 'Scorecard',
    rows: [
      ['Physics', 'physicsMarks'],
      ['Chemistry', 'chemistryMarks'],
      ['Biology', 'biologyMarks'],
      ['Maths', 'mathsMarks'],
      ['PCB %', 'pcbPercentage'],
      ['PCM %', 'pcmPercentage'],
      ['NEET (previous)', 'previousNeetMarks'],
      ['NEET (current)', 'presentNeetMarks'],
    ],
  },
];

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Renders the unstorable detail as one readable remark, or null when the user
 * filled none of it in -- an empty "Academic profile" note on every student
 * would be worse than no note at all.
 */
export function describeProfileDetail(detail: ProfileDetail): string | null {
  const sections: string[] = [];

  for (const group of PROFILE_GROUPS) {
    const lines = group.rows
      .filter(([, key]) => isFilled(detail[key]))
      .map(([label, key]) => `  ${label}: ${String(detail[key])}`);
    if (lines.length > 0) sections.push(`${group.heading}\n${lines.join('\n')}`);
  }

  const flags: string[] = [];
  if (detail.gapYear) {
    const span =
      detail.gapYearFrom && detail.gapYearTo ? ` (${detail.gapYearFrom}–${detail.gapYearTo})` : '';
    flags.push(`  Gap year: yes${span}`);
  }
  if (detail.collegeDropout) flags.push('  College dropout: yes');
  if (flags.length > 0) sections.push(`Status\n${flags.join('\n')}`);

  if (sections.length === 0) return null;

  return [
    'Academic & personal profile (captured at registration).',
    'Recorded here because the API has no columns for these fields.',
    '',
    ...sections,
  ].join('\n');
}

/** Alias kept for call sites that import the older name. */
export const listPaymentsFor = paymentsFor;
