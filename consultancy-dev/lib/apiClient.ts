import { api, API_URL } from './api';
import type {
  Agent,
  ApiKey,
  ApiKeyCreated,
  Appointment,
  ApprovalRequest,
  Branch,
  Commission,
  Company,
  Document,
  DocumentTransfer,
  Enquiry,
  Enrollment,
  EnrollmentInput,
  FollowUp,
  FollowUpComment,
  MyCapabilities,
  Notification,
  PageParams,
  Paginated,
  Payment,
  PaymentInput,
  PermissionChange,
  PermissionMatrix,
  Plan,
  RecordTransfer,
  Refund,
  RefundInput,
  Registration,
  RegistrationInput,
  Registration as RegistrationType,
  SignupRequest,
  StudentDocument,
  StudentDocumentInput,
  StudentDocumentReturnResult,
  StudentRemark,
  StudyPreference,
  Subscription,
  Task,
  Template,
  University,
  User,
  UserAdminInput,
  CounselorPerformance,
  AppointmentInput,
  UniversityInput,
  FollowUpInput,
  CompanyInput,
  VisaTracking,
  ScopedFields,
} from './types';

/* -------------------------------------------------------------------------- */
/* Pagination helpers                                                          */
/* -------------------------------------------------------------------------- */

type QueryValue = string | number | boolean | readonly string[];

/**
 * Flattens `filters` into top-level query params and drops empty entries so we
 * never send `?search=undefined`.
 *
 * An empty array is dropped too. A multi-select the user has cleared must mean
 * "no filter", not `?status=` -- axios omits the key for `[]`, but being
 * explicit here keeps the intent readable at the one place it is decided.
 */
function cleanParams(params: PageParams): Record<string, QueryValue> {
  const { filters, ...rest } = params;
  const out: Record<string, QueryValue> = {};

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value as string | number;
  }
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Fetches one page of a list endpoint.
 *
 * Every list endpoint returns the envelope
 * `{count, pages, page, page_size, next, previous, results}` -- there are no
 * bare-array list responses.
 *
 * @example
 * const page = await fetchPage<User>('users/', { page: 2, search: 'ana' });
 * page.results // User[]
 */
export async function fetchPage<T>(
  resource: string,
  params: PageParams = {}
): Promise<Paginated<T>> {
  const res = await api.get<Paginated<T>>(resource, { params: cleanParams(params) });
  return res.data;
}

/** `fetchPage` plus a row mapper, preserving the envelope metadata. */
export async function fetchPageMapped<TRaw, TOut>(
  resource: string,
  mapper: (raw: TRaw) => TOut,
  params: PageParams = {}
): Promise<Paginated<TOut>> {
  const page = await fetchPage<TRaw>(resource, params);
  return { ...page, results: page.results.map(mapper) };
}

/**
 * Walks every page of a list endpoint.
 *
 * Only for aggregate views that genuinely need the whole collection. Bounded by
 * `maxPages` so a large table cannot spin off hundreds of requests.
 */
export async function fetchAllPages<TRaw, TOut>(
  resource: string,
  mapper: (raw: TRaw) => TOut,
  params: Omit<PageParams, 'page' | 'page_size'> = {},
  pageSize = 100,
  maxPages = 20
): Promise<TOut[]> {
  const rows: TOut[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const envelope = await fetchPage<TRaw>(resource, {
      ...params,
      page,
      page_size: pageSize,
    });
    rows.push(...envelope.results.map(mapper));
    totalPages = envelope.pages;
    page += 1;
  } while (page <= totalPages && page <= maxPages);

  return rows;
}

/** Total row count without transferring the rows. */
export async function fetchCount(resource: string, params: PageParams = {}): Promise<number> {
  const envelope = await fetchPage<unknown>(resource, { ...params, page: 1, page_size: 1 });
  return envelope.count;
}

/** An empty envelope, for error fallbacks that must still satisfy `Paginated<T>`. */
export function emptyPage<T>(pageSize = 20): Paginated<T> {
  return {
    count: 0,
    pages: 0,
    page: 1,
    page_size: pageSize,
    next: null,
    previous: null,
    results: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Wire (snake_case) shapes and mappers                                        */
/* -------------------------------------------------------------------------- */

/**
 * The enquiry wire shape, as EnquirySerializer actually sends it.
 *
 * `gapYear` and `collegeDropout` used to be declared here in camelCase. The
 * server sends `gap_year` and `college_dropout`, so both read as `undefined`
 * on every row -- and because the declaration said otherwise, nothing
 * complained. A mapper is only ever as honest as its `Raw` type.
 */
interface RawEnquiry extends Partial<ScopedFields> {
  id: string;
  date: string;
  stream: Enquiry['stream'];
  mobile: string;
  email: string;
  status: Enquiry['status'];
  candidate_name: string;
  school_name: string;
  course_interested: string;
  father_name: string;
  mother_name: string;
  father_occupation?: string;
  mother_occupation?: string;
  father_mobile?: string;
  mother_mobile?: string;
  permanent_address: string;
  preferred_locations: string | string[] | null;
  other_location?: string;

  gender?: string;
  date_of_birth?: string | null;
  caste?: string;
  religion?: string;
  family_place?: string;
  family_state?: string;
  school_board?: string;
  school_place?: string;
  school_state?: string;
  class12_passing_year?: string;
  class12_percentage?: number | string | null;
  class10_school_name?: string;
  class10_board?: string;
  class10_passing_year?: string;
  class10_place?: string;
  class10_state?: string;
  class10_percentage?: number | string | null;
  physics_marks?: number | string | null;
  chemistry_marks?: number | string | null;
  biology_marks?: number | string | null;
  maths_marks?: number | string | null;
  pcb_percentage?: number | string | null;
  pcm_percentage?: number | string | null;
  previous_neet_marks?: number | string | null;
  present_neet_marks?: number | string | null;
  gap_year?: boolean;
  gap_year_from?: number | null;
  gap_year_to?: number | null;
  college_dropout?: boolean;
  payment_amount?: number | string | null;
}

const mapEnquiry = (data: RawEnquiry): Enquiry => ({
  ...data,
  candidateName: data.candidate_name,
  schoolName: data.school_name,
  courseInterested: data.course_interested,
  fatherName: data.father_name,
  motherName: data.mother_name,
  fatherOccupation: data.father_occupation,
  motherOccupation: data.mother_occupation,
  fatherMobile: data.father_mobile,
  motherMobile: data.mother_mobile,
  permanentAddress: data.permanent_address,
  preferredLocations: parseLocations(data.preferred_locations),
  otherLocation: data.other_location,

  dateOfBirth: data.date_of_birth,
  familyPlace: data.family_place,
  familyState: data.family_state,
  schoolBoard: data.school_board,
  schoolPlace: data.school_place,
  schoolState: data.school_state,
  class12PassingYear: data.class12_passing_year,
  class12Percentage: data.class12_percentage,
  class10SchoolName: data.class10_school_name,
  class10Board: data.class10_board,
  class10PassingYear: data.class10_passing_year,
  class10Place: data.class10_place,
  class10State: data.class10_state,
  class10Percentage: data.class10_percentage,
  physicsMarks: data.physics_marks,
  chemistryMarks: data.chemistry_marks,
  biologyMarks: data.biology_marks,
  mathsMarks: data.maths_marks,
  pcbPercentage: data.pcb_percentage,
  pcmPercentage: data.pcm_percentage,
  previousNeetMarks: data.previous_neet_marks,
  presentNeetMarks: data.present_neet_marks,
  gapYear: data.gap_year ?? false,
  gapYearFrom: data.gap_year_from,
  gapYearTo: data.gap_year_to,
  collegeDropout: data.college_dropout ?? false,
  paymentAmount: data.payment_amount,
});

/**
 * Tolerates the two shapes this column holds.
 *
 * It is a JSONField, so it should always be a list -- but every enquiry saved
 * before `toEnquiryPayload` was fixed went in as a `JSON.stringify`-ed string
 * and came back as one. New rows are lists; these stay readable.
 *
 * Note that the string rows are readable but NOT filterable: the server's
 * preferred-location filter looks inside a JSON array, and a string that
 * happens to contain JSON is not one.
 */
function parseLocations(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

interface RawRegistration {
  id: string;
  mobile: string;
  email: string;
  preferences: StudyPreference[];
  registration_no: string;
  student_name: string;
  registration_date: string;
  needs_loan: boolean;
  payment_status: RegistrationType['paymentStatus'];
  payment_method: RegistrationType['paymentMethod'];
  registration_fee: number;
  father_name: string;
  mother_name: string;
  permanent_address: string;
  created_by_name?: string;
}

const mapRegistration = (data: RawRegistration): Registration => ({
  ...data,
  registrationNo: data.registration_no,
  studentName: data.student_name,
  registrationDate: data.registration_date,
  needsLoan: data.needs_loan,
  paymentStatus: data.payment_status,
  paymentMethod: data.payment_method,
  registrationFee: data.registration_fee,
  fatherName: data.father_name,
  motherName: data.mother_name,
  permanentAddress: data.permanent_address,
});

/**
 * The enrollment wire shape, as EnrollmentSerializer actually sends it.
 *
 * `serviceCharge` / `schoolFees` / `hostelFees` / `paymentType` /
 * `loanRequired` / `loanAmount` used to be declared here. Only one of them was
 * real: `serviceCharge` was an alias for `commission_amount`, which still
 * exists and is still writable — it was a RENAME, not a deletion, and dropping
 * it would have silently removed a live field. The others were never
 * persisted: schoolFees/hostelFees were write-only and summed into
 * `total_fees`, `paymentType` is now expressed by `installments_count`, and
 * `loanRequired` lives on `Registration.needs_loan`.
 */
interface RawEnrollment {
  id: string;
  status: Enrollment['status'];
  installments?: Enrollment['installments'];
  enrollment_no: string;
  /** FK to Registration — the field the serializer requires on write. */
  student: number;
  student_name: string;
  program_name: string;
  university?: number | null;
  university_name?: string;
  country?: string;
  start_date: string;
  duration_months: number;
  total_fees: number;
  /** Formerly surfaced as `serviceCharge`. */
  commission_amount?: number;
  created_by_name?: string;
  branch_name?: string;
  owner?: number | null;
  owner_name?: string;
}

const mapEnrollment = (data: RawEnrollment): Enrollment => ({
  ...data,
  enrollmentNo: data.enrollment_no,
  studentName: data.student_name,
  programName: data.program_name,
  startDate: data.start_date,
  durationMonths: data.duration_months,
  totalFees: Number(data.total_fees),
  commission_amount:
    data.commission_amount === undefined ? undefined : Number(data.commission_amount),
});

interface RawDocument {
  id: string;
  type: string;
  status: Document['status'];
  file_name: string;
  uploaded_at: string;
  uploaded_by_name?: string;
  student_name?: string;
  registration_no?: string;
  registration?: string | null;
  enquiry?: string | null;
  expiry_date?: string;
  file_size?: number;
  mime_type?: string;
}

const mapDocument = (d: RawDocument): Document => ({
  id: d.id,
  type: d.type,
  status: d.status,
  fileName: d.file_name,
  uploadedBy: d.uploaded_by_name ?? 'Unknown',
  uploadedAt: d.uploaded_at,
  studentName: d.student_name,
  registrationNo: d.registration_no,
  registration: d.registration ?? null,
  enquiry: d.enquiry ?? null,
  expiryDate: d.expiry_date,
  fileSize: d.file_size,
  mimeType: d.mime_type,
});

interface RawPayment {
  id: string;
  date: string;
  type: Payment['type'];
  amount: number;
  status: Payment['status'];
  method: Payment['method'];
  student_name: string;
  payment_date?: string;
  registration?: number | null;
  enrollment?: number | null;
  installment?: number | null;
  reference?: string;
  metadata?: Record<string, unknown>;
  branch_name?: string;
  created_by_name?: string;
}

/**
 * A hand-written mapper is a place where the type and the wire can drift
 * apart silently.
 *
 * When `Payment` gained registration/enrollment/installment/reference this
 * mapper was not updated, so those keys type-checked at every call site and
 * were ALWAYS undefined — the serializer sent them and the client threw them
 * away. That is worse than not declaring them, because the type then promises
 * data the client provably never returns. Every field on `Payment` must be
 * passed through here.
 */
const mapPayment = (p: RawPayment): Payment => ({
  id: p.id,
  date: p.date ?? p.payment_date ?? '',
  type: p.type,
  amount: Number(p.amount),
  status: p.status,
  method: p.method,
  studentName: p.student_name,
  registration: p.registration ?? null,
  enrollment: p.enrollment ?? null,
  installment: p.installment ?? null,
  reference: p.reference ?? '',
  metadata: p.metadata ?? {},
  branch_name: p.branch_name,
  created_by_name: p.created_by_name,
});

// Appointments, universities and follow-ups are consumed in the serializer's
// own snake_case. They previously went through hand-written camelCase mappers,
// which silently drifted from the serializers -- a renamed field just produced
// `undefined` at runtime instead of a compile error. One shape, one source of
// truth.

interface RawTask {
  id: string;
  title: string;
  status: Task['status'];
  assigned_to: string;
  due_date: string;
}

const mapTask = (t: RawTask): Task => ({
  ...t,
  assignedTo: t.assigned_to,
  dueDate: t.due_date,
});

/**
 * The wire shape of NotificationSerializer.
 *
 * This declared `read: boolean`, but the serializer sends `is_read`
 * (backend/core/serializers.py). Because `mapNotification` spread the raw row
 * without translating it, `Notification.read` was `undefined` on EVERY row —
 * so the whole tray rendered as unread, the read/unread counts were wrong, and
 * marking one as read never changed its appearance even after a refetch.
 *
 * It type-checked the entire time, because the raw interface simply asserted a
 * field name the API does not send. A mapper is only as honest as its `Raw`
 * declaration.
 */
interface RawNotification {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
  action_url?: string;
}

const mapNotification = (n: RawNotification): Notification => ({
  ...n,
  read: n.is_read,
  actionUrl: n.action_url,
});

interface RawTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  type: string;
  is_active: boolean;
  usage_count?: number;
}

const mapTemplate = (t: RawTemplate): Template => ({
  ...t,
  isActive: t.is_active,
  usageCount: t.usage_count ?? 0,
});

interface RawCommission {
  id: string;
  status: Commission['status'];
  agent_name: string;
  student_name: string;
  enrollment_no: string;
  enrollment_fee: number;
  commission_amount: number;
  enrollment_date: string;
}

const mapCommission = (c: RawCommission): Commission => ({
  ...c,
  agentName: c.agent_name,
  studentName: c.student_name,
  enrollmentNo: c.enrollment_no,
  enrollmentFee: c.enrollment_fee,
  commissionAmount: c.commission_amount,
  enrollmentDate: c.enrollment_date,
});

interface RawAgent {
  id: string;
  name: string;
  email: string;
  phone?: string;
  status: Agent['status'];
  commission_type: Agent['commissionType'];
  commission_value: number;
  total_earned: number;
  pending_amount: number;
  students_referred: number;
}

const mapAgent = (a: RawAgent): Agent => ({
  ...a,
  commissionType: a.commission_type,
  commissionValue: a.commission_value,
  totalEarned: a.total_earned,
  pendingAmount: a.pending_amount,
  studentsReferred: a.students_referred,
});

interface RawVisaTracking {
  id: string;
  country: string;
  status: string;
  student_name: string;
  passport_no: string;
  visa_type: string;
  applied_date: string;
  current_stage: string;
  interview_date?: string;
  expected_decision?: string;
}

const mapVisaTracking = (v: RawVisaTracking): VisaTracking => ({
  ...v,
  studentName: v.student_name,
  passportNo: v.passport_no,
  visaType: v.visa_type,
  appliedDate: v.applied_date,
  currentStage: v.current_stage,
  interviewDate: v.interview_date,
  expectedDecision: v.expected_decision,
});

interface RawSignupRequest {
  id: string;
  username: string;
  email: string;
  phone?: string;
  plan: string;
  status: SignupRequest['status'];
  company_name: string;
  admin_name: string;
  requested_at: string;
}

const mapSignupRequest = (s: RawSignupRequest): SignupRequest => ({
  ...s,
  companyName: s.company_name,
  adminName: s.admin_name,
  requestedAt: s.requested_at,
});

/* -------------------------------------------------------------------------- */
/* Write payloads                                                              */
/* -------------------------------------------------------------------------- */

/** Mirrors what `EnquiryForm` produces, so the form's output needs no cast. */
export interface EnquiryInput {
  date?: string;
  stream: Enquiry['stream'];
  mobile: string;
  email: string;
  status?: Enquiry['status'];
  candidateName: string;
  schoolName: string;
  courseInterested: string;
  fatherName: string;
  motherName: string;
  fatherOccupation?: string;
  motherOccupation?: string;
  fatherMobile?: string;
  motherMobile?: string;
  permanentAddress: string;
  preferredLocations?: string[];
  otherLocation?: string;

  // Academic and eligibility profile. Optional: a walk-in enquiry is often
  // taken before the candidate has their marksheets to hand.
  gender?: string;
  dob?: string;
  caste?: string;
  religion?: string;
  familyPlace?: string;
  familyState?: string;
  schoolBoard?: string;
  schoolPlace?: string;
  schoolState?: string;
  class12PassingYear?: string;
  class12Percentage?: number;
  class10SchoolName?: string;
  class10Board?: string;
  class10PassingYear?: string;
  class10Place?: string;
  class10State?: string;
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
  paymentAmount?: number;
}

/**
 * Serialises an enquiry for the API.
 *
 * Two defects lived in the previous version, and neither was visible from the
 * UI because both produced a 200:
 *
 *   - `gapYear` and `collegeDropout` went out in camelCase. DRF drops keys it
 *     does not recognise, so every save stored `false` regardless.
 *   - `preferred_locations` was `JSON.stringify`-ed before sending. The column
 *     is a JSONField, so it faithfully stored the STRING `"[\"Kota\"]"` rather
 *     than a list -- which is why reading it back needs a parser, and why a
 *     server-side query for candidates who prefer Kota matched nothing.
 *
 * The academic block was not sent at all. Those columns exist precisely so the
 * counsellor's eligibility notes survive; without them the form was a form
 * that threw most of its answers away.
 *
 * Blank optional values are OMITTED rather than sent as `''`: these are
 * nullable date and decimal columns, and an empty string is a 400 from DRF,
 * not an empty value.
 */
const toEnquiryPayload = (data: EnquiryInput): Record<string, unknown> => {
  // `date` is `auto_now_add` server-side and therefore read-only; sending it
  // has never had any effect.
  const payload: Record<string, unknown> = {
    stream: data.stream,
    mobile: data.mobile,
    email: data.email,
    candidate_name: data.candidateName,
    school_name: data.schoolName,
    course_interested: data.courseInterested,
    father_name: data.fatherName,
    mother_name: data.motherName,
    permanent_address: data.permanentAddress,
    preferred_locations: data.preferredLocations ?? [],
    gap_year: data.gapYear ?? false,
    college_dropout: data.collegeDropout ?? false,
  };

  const optional: Record<string, unknown> = {
    status: data.status,
    father_occupation: data.fatherOccupation,
    mother_occupation: data.motherOccupation,
    father_mobile: data.fatherMobile,
    mother_mobile: data.motherMobile,
    other_location: data.otherLocation,
    gender: data.gender,
    caste: data.caste,
    religion: data.religion,
    family_place: data.familyPlace,
    family_state: data.familyState,
    school_board: data.schoolBoard,
    school_place: data.schoolPlace,
    school_state: data.schoolState,
    class12_passing_year: data.class12PassingYear,
    class12_percentage: data.class12Percentage,
    class10_school_name: data.class10SchoolName,
    class10_board: data.class10Board,
    class10_passing_year: data.class10PassingYear,
    class10_place: data.class10Place,
    class10_state: data.class10State,
    class10_percentage: data.class10Percentage,
    physics_marks: data.physicsMarks,
    chemistry_marks: data.chemistryMarks,
    biology_marks: data.biologyMarks,
    maths_marks: data.mathsMarks,
    pcb_percentage: data.pcbPercentage,
    pcm_percentage: data.pcmPercentage,
    previous_neet_marks: data.previousNeetMarks,
    present_neet_marks: data.presentNeetMarks,
    gap_year_from: data.gapYearFrom,
    gap_year_to: data.gapYearTo,
    payment_amount: data.paymentAmount,
  };

  for (const [key, value] of Object.entries(optional)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    payload[key] = value;
  }

  // An untouched DOB is omitted; explicitly clearing it must persist as null.
  if (data.dob !== undefined) payload.date_of_birth = data.dob || null;
  return payload;
};

export /**
 * Serialises a registration for the API.
 *
 * `RegistrationInput` lives in ./types and already uses the serializer's field
 * names, so this mostly passes values through. A second, camelCase copy was
 * declared here and shadowed it — two types with the same name meant a value
 * built against one was rejected by a function expecting the other.
 *
 * `registration_no` is omitted when blank: the server allocates the next
 * per-company reference. It used to be required with no generator, so every
 * create that left it out returned 400.
 */
const toRegistrationPayload = (data: RegistrationInput): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    student_name: data.student_name,
    mobile: data.mobile,
    email: data.email,
    registration_fee: data.registration_fee,
  };
  if (data.registration_no) payload.registration_no = data.registration_no;
  if (data.date_of_birth !== undefined) payload.date_of_birth = data.date_of_birth;
  if (data.father_name !== undefined) payload.father_name = data.father_name;
  if (data.mother_name !== undefined) payload.mother_name = data.mother_name;
  if (data.permanent_address !== undefined) payload.permanent_address = data.permanent_address;
  if (data.payment_method !== undefined) payload.payment_method = data.payment_method;
  if (data.payment_status !== undefined) payload.payment_status = data.payment_status;
  if (data.needs_loan !== undefined) payload.needs_loan = data.needs_loan;
  if (data.preferences !== undefined) payload.preferences = data.preferences;
  // Preserves the link back to the enquiry this was converted from.
  if (data.enquiry != null) payload.enquiry = data.enquiry;
  return payload;
};

/**
 * Serialises an enrollment for the API.
 *
 * The previous version of this function could not create an enrollment at all.
 * It sent `student_id`, `serviceCharge`, `schoolFees`, `hostelFees`,
 * `paymentType`, `loanRequired` and `loanAmount` — NONE of which exist on
 * EnrollmentSerializer — while omitting the required `student` FK. Every call
 * returned 400.
 *
 * `EnrollmentInput` now lives in ./types with the serializer's real field
 * names; a second, stale copy was declared here and shadowed it.
 *
 * `enrollment_no` is deliberately omitted when blank: the server allocates the
 * next per-company reference.
 */
const toEnrollmentPayload = (data: EnrollmentInput): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    student: data.student,
    program_name: data.program_name,
    start_date: data.start_date,
    duration_months: data.duration_months,
    total_fees: data.total_fees,
  };
  if (data.enrollment_no) payload.enrollment_no = data.enrollment_no;
  if (data.university != null) payload.university = data.university;
  if (data.university_name !== undefined) payload.university_name = data.university_name;
  if (data.country !== undefined) payload.country = data.country;
  if (data.commission_amount !== undefined) payload.commission_amount = data.commission_amount;
  if (data.status !== undefined) payload.status = data.status;
  if (data.installments_count !== undefined) payload.installments_count = data.installments_count;
  if (data.installment_amount !== undefined) payload.installment_amount = data.installment_amount;
  return payload;
};

export interface DocumentUploadInput {
  file: File;
  type: string;
  studentName?: string;
  /**
   * The link. Send one of these, not a typed-in name: the server derives
   * `student_name` from whichever is set, so a document can no longer claim
   * a student it is not attached to.
   */
  registration?: string;
  enquiry?: string;
  expiryDate?: string;
  status?: Document['status'];
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Analytics response shapes.
 *
 * These endpoints are plain APIViews, NOT viewsets -- they are never paginated
 * and return bare objects/arrays. All figures are already role-scoped by the
 * backend, so no client-side filtering by company or branch is needed.
 */

/** GET analytics/overview/ */
export interface AnalyticsOverview {
  enquiries: number;
  enquiriesThisMonth: number;
  enquiriesLastMonth: number;
  /** Percent change this month vs last, computed server-side from real counts. */
  enquiriesTrend: number;
  registrations: number;
  registrationsThisMonth: number;
  registrationsLastMonth: number;
  registrationsTrend: number;
  enrollments: number;
  enrollmentsThisMonth: number;
  enrollmentsLastMonth: number;
  enrollmentsTrend: number;
  converted: number;
  conversionRate: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  revenueGrowth: number;
  /** Sum of pending payment AMOUNTS, not a count. */
  pendingPayments: number;
  totalRevenue: number;
}

/**
 * What the dashboard renders: a value plus its movement.
 *
 * Every `trend` here is computed by the backend from actual prior-period
 * counts. A hardcoded or invented trend is worse than showing none, because an
 * arrow reads as a measurement.
 */
export interface DashboardMetric {
  value: number;
  trend: number;
}

export interface DashboardStats {
  enquiries: DashboardMetric;
  registrations: DashboardMetric;
  enrollments: DashboardMetric;
  totalEarnings: DashboardMetric;
  pendingPaymentsAmount: number;
  pendingTransfers: number;
  conversionRate: number;
}

/** GET analytics/funnel/ */
export interface AnalyticsFunnel {
  stages: Array<{ stage: string; count: number; rate: number }>;
  dropOff: {
    enquiryToRegistration: number;
    registrationToEnrollment: number;
    enrollmentToVisa: number;
  };
}

export interface RevenuePoint {
  /** `YYYY-MM`, or null for rows with no date bucket. */
  month: string | null;
  label: string;
  revenue: number;
  transactions: number;
  registrationFees: number;
  enrollmentFees: number;
  otherFees: number;
  commissions: number;
}

/** GET analytics/branches/ */
export interface BranchAnalyticsRow {
  id: number;
  name: string;
  city: string | null;
  staff: number;
  enquiries: number;
  registrations: number;
  enrollments: number;
  revenue: number;
  conversionRate: number;
}

/** GET analytics/visa-pipeline/ */
export interface VisaPipeline {
  pipeline: Array<{ stage: string; count: number }>;
  total: number;
}

/** GET analytics/sources/ */
export interface SourceAnalyticsRow {
  source: string;
  total: number;
  converted: number;
  conversionRate: number;
}

export interface ActivityItem {
  id: string;
  text: string;
  time: string;
  timestamp: number;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export const apiClient = {
  dashboard: {
    /**
     * Dashboard counters.
     *
     * Sourced from `analytics/overview/`, which the backend already scopes to
     * the caller's role and computes with grouped queries. The transfer count
     * comes from the inbox envelope's `count`, so no rows are transferred.
     */
    /**
     * Headline figures for the dashboard, all computed in SQL across the
     * caller's full scope by `analytics/overview/` — never reduced from a
     * single page of rows.
     */
    getStats: async (): Promise<DashboardStats> => {
      const [overview, inbox] = await Promise.all([
        apiClient.analytics.getOverview(),
        fetchPage<unknown>('transfers/inbox/', { page: 1, page_size: 1 }),
      ]);

      return {
        enquiries: { value: overview.enquiries, trend: overview.enquiriesTrend },
        registrations: { value: overview.registrations, trend: overview.registrationsTrend },
        enrollments: { value: overview.enrollments, trend: overview.enrollmentsTrend },
        totalEarnings: { value: overview.totalRevenue, trend: overview.revenueGrowth },
        pendingPaymentsAmount: overview.pendingPayments,
        pendingTransfers: inbox.count,
        conversionRate: overview.conversionRate,
      };
    },

    getWeeklyData: async (): Promise<Array<{ name: string; enquiries: number; registrations: number; enrollments: number }>> => {
      // `ordering` values must appear in the endpoint's `ordering_fields`;
      // an unlisted field is silently ignored and you get unordered rows.
      const [enquiries, registrations, enrollments] = await Promise.all([
        fetchAllPages<RawEnquiry, RawEnquiry>('enquiries/', (r) => r, { ordering: '-created_at' }),
        fetchAllPages<RawRegistration, RawRegistration>('registrations/', (r) => r, {
          ordering: '-created_at',
        }),
        fetchAllPages<RawEnrollment, RawEnrollment>('enrollments/', (r) => r, {
          ordering: '-start_date',
        }),
      ]);

      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const today = new Date();
      const last7Days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (6 - i));
        return d;
      });

      return last7Days.map((date, index) => {
        const dateStr = date.toISOString().split('T')[0];
        const isToday = index === last7Days.length - 1;

        return {
          name: days[date.getDay()],
          enquiries: enquiries.filter((i) => i.date?.startsWith(dateStr)).length,
          registrations: registrations.filter((i) => i.registration_date?.startsWith(dateStr)).length,
          // Enrollments only carry start_date (a future date), so there is no
          // meaningful per-day bucket; surface the total on today's bar.
          enrollments: isToday ? enrollments.length : 0,
        };
      });
    },

    // Monthly revenue lives at `analytics/revenue/` -- use
    // `apiClient.analytics.getRevenue()`. It is one grouped query server-side
    // and returns a richer breakdown than aggregating payments on the client.

    getActivity: async (): Promise<ActivityItem[]> => {
      const [enquiries, registrations, payments] = await Promise.all([
        fetchPage<RawEnquiry>('enquiries/', { page_size: 5, ordering: '-created_at' }),
        fetchPage<RawRegistration>('registrations/', { page_size: 5, ordering: '-created_at' }),
        fetchPage<RawPayment>('payments/', { page_size: 5, ordering: '-date' }),
      ]);

      const activities: ActivityItem[] = [
        ...enquiries.results.map((i) => ({
          id: `enq-${i.id}`,
          text: `New enquiry from ${i.candidate_name}`,
          time: new Date(i.date).toLocaleDateString(),
          timestamp: new Date(i.date).getTime(),
        })),
        ...registrations.results.map((i) => ({
          id: `reg-${i.id}`,
          text: `New registration: ${i.student_name}`,
          time: new Date(i.registration_date).toLocaleDateString(),
          timestamp: new Date(i.registration_date).getTime(),
        })),
        ...payments.results.map((i) => {
          const paidOn = i.payment_date ?? i.date;
          return {
            id: `pay-${i.id}`,
            text: `Payment received: ₹${i.amount} from ${i.student_name}`,
            time: new Date(paidOn).toLocaleDateString(),
            timestamp: new Date(paidOn).getTime(),
          };
        }),
      ];

      return activities.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    },

    getRecentEnquiries: async (): Promise<Array<{ name: string; course: string; time: string; status: string }>> => {
      const page = await fetchPage<RawEnquiry>('enquiries/', { page_size: 5, ordering: '-created_at' });
      return page.results.map((e) => ({
        name: e.candidate_name,
        course: e.course_interested,
        time: new Date(e.date).toLocaleDateString(),
        status: e.status || 'New',
      }));
    },

    /** Bare array, not paginated. Covers active EMPLOYEE and BRANCH_MANAGER users. */
    getCounselorAnalytics: async (): Promise<CounselorPerformance[]> => {
      const res = await api.get<CounselorPerformance[]>('users/counselors/');
      return res.data;
    },

    getPaymentStats: async (): Promise<unknown> => {
      const res = await api.get<unknown>('payments/stats/');
      return res.data;
    },
  },

  enquiries: {
    list: (params: PageParams = {}): Promise<Paginated<Enquiry>> =>
      fetchPageMapped<RawEnquiry, Enquiry>('enquiries/', mapEnquiry, params),
    get: async (id: string): Promise<Enquiry> => {
      const res = await api.get<RawEnquiry>(`enquiries/${id}/`);
      return mapEnquiry(res.data);
    },
    create: async (data: EnquiryInput): Promise<Enquiry> => {
      const res = await api.post<RawEnquiry>('enquiries/', toEnquiryPayload(data));
      return mapEnquiry(res.data);
    },
    update: async (id: string, data: EnquiryInput): Promise<Enquiry> => {
      const res = await api.put<RawEnquiry>(`enquiries/${id}/`, toEnquiryPayload(data));
      return mapEnquiry(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`enquiries/${id}/`);
    },
  },

  registrations: {
    list: (params: PageParams = {}): Promise<Paginated<Registration>> =>
      fetchPageMapped<RawRegistration, Registration>('registrations/', mapRegistration, params),
    get: async (id: string): Promise<Registration> => {
      const res = await api.get<RawRegistration>(`registrations/${id}/`);
      return mapRegistration(res.data);
    },
    create: async (data: RegistrationInput): Promise<Registration> => {
      const res = await api.post<RawRegistration>('registrations/', toRegistrationPayload(data));
      return mapRegistration(res.data);
    },
    update: async (id: string, data: RegistrationInput): Promise<Registration> => {
      const res = await api.patch<RawRegistration>(`registrations/${id}/`, toRegistrationPayload(data));
      return mapRegistration(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`registrations/${id}/`);
    },
  },

  enrollments: {
    list: (params: PageParams = {}): Promise<Paginated<Enrollment>> =>
      fetchPageMapped<RawEnrollment, Enrollment>('enrollments/', mapEnrollment, params),
    get: async (id: string): Promise<Enrollment> => {
      const res = await api.get<RawEnrollment>(`enrollments/${id}/`);
      return mapEnrollment(res.data);
    },
    create: async (data: EnrollmentInput): Promise<Enrollment> => {
      const res = await api.post<RawEnrollment>('enrollments/', toEnrollmentPayload(data));
      return mapEnrollment(res.data);
    },
    update: async (id: string, data: EnrollmentInput): Promise<Enrollment> => {
      const res = await api.put<RawEnrollment>(`enrollments/${id}/`, toEnrollmentPayload(data));
      return mapEnrollment(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`enrollments/${id}/`);
    },
  },

  documents: {
    list: (params: PageParams = {}): Promise<Paginated<Document>> =>
      fetchPageMapped<RawDocument, Document>('documents/', mapDocument, params),

    /**
     * Real multipart upload.
     *
     * The binary goes in the `file` field; the axios instance deliberately has
     * no default Content-Type so the browser adds the multipart boundary.
     */
    upload: async (input: DocumentUploadInput): Promise<Document> => {
      const formData = new FormData();
      formData.append('file', input.file);
      formData.append('type', input.type);
      formData.append('status', input.status ?? 'IN');
      // `registration_no` was sent here and was never a field on
      // DocumentSerializer, so DRF dropped it and every upload landed
      // unlinked. The server derives student_name from the FK now.
      if (input.registration) formData.append('registration', input.registration);
      if (input.enquiry) formData.append('enquiry', input.enquiry);
      if (input.expiryDate) formData.append('expiry_date', input.expiryDate);

      const res = await api.post<RawDocument>('documents/', formData);
      return mapDocument(res.data);
    },

    /** Absolute URL of a document's download endpoint. */
    downloadUrl: (id: string): string => `${API_URL}documents/${id}/download/`,

    /**
     * Downloads a document as a Blob.
     *
     * Goes through axios rather than a plain link so the Authorization header
     * is attached and a 401 still triggers the refresh flow.
     */
    download: async (id: string): Promise<Blob> => {
      const res = await api.get<Blob>(`documents/${id}/download/`, { responseType: 'blob' });
      return res.data;
    },

    /** Downloads and saves a document under `fileName`. */
    downloadAndSave: async (id: string, fileName: string): Promise<void> => {
      const blob = await apiClient.documents.download(id);
      const url = window.URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    },

    toggleStatus: async (id: string, status: Document['status']): Promise<void> => {
      await api.patch(`documents/${id}/`, { status });
    },

    getExpiringSoon: (params: PageParams = {}): Promise<Paginated<Document>> =>
      fetchPageMapped<RawDocument, Document>('documents/expiring-soon/', mapDocument, params),

    delete: async (id: string): Promise<void> => {
      await api.delete(`documents/${id}/`);
    },
  },

  payments: {
    list: (params: PageParams = {}): Promise<Paginated<Payment>> =>
      fetchPageMapped<RawPayment, Payment>('payments/', mapPayment, params),
    /**
     * The links back to registration/enrollment/installment are what make a
     * payment reconcilable. Dropping them (as the previous version did) is why
     * the old build had to match payments to students by NAME.
     */
    create: async (data: PaymentInput): Promise<Payment> => {
      const res = await api.post<RawPayment>('payments/', {
        date: data.date,
        type: data.type,
        amount: data.amount,
        status: data.status,
        method: data.method,
        reference: data.reference,
        registration: data.registration,
        enrollment: data.enrollment,
        installment: data.installment,
        student_name: data.student_name,
      });
      return mapPayment(res.data);
    },
    update: async (id: number | string, data: Partial<PaymentInput>): Promise<Payment> => {
      const res = await api.patch<RawPayment>(`payments/${id}/`, data);
      return mapPayment(res.data);
    },
    get: async (id: number | string): Promise<Payment> => {
      const res = await api.get<RawPayment>(`payments/${id}/`);
      return mapPayment(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`payments/${id}/`);
    },
  },

  installments: {
    list: (params: PageParams = {}): Promise<Paginated<Record<string, unknown>>> =>
      fetchPage<Record<string, unknown>>('installments/', params),
  },

  appointments: {
    list: (params: PageParams = {}): Promise<Paginated<Appointment>> =>
      fetchPage<Appointment>('appointments/', params),
    get: async (id: number | string): Promise<Appointment> => {
      const res = await api.get<Appointment>(`appointments/${id}/`);
      return res.data;
    },
    create: async (data: AppointmentInput): Promise<Appointment> => {
      const res = await api.post<Appointment>('appointments/', data);
      return res.data;
    },
    update: async (id: number | string, data: Partial<AppointmentInput>): Promise<Appointment> => {
      const res = await api.patch<Appointment>(`appointments/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`appointments/${id}/`);
    },
    /**
     * Every appointment in one month, unpaginated.
     *
     * `search` and `filters` are honoured here exactly as they are on the
     * paginated list: the action runs `filter_queryset`, so the same drawer and
     * search box drive both views. That is what makes grouping the result by
     * day — and counting it — legitimate: the set is COMPLETE for the query,
     * unlike one page of a paginated list.
     */
    getCalendarView: async (params: {
      month?: number;
      year?: number;
      search?: string;
      filters?: PageParams['filters'];
    } = {}): Promise<Appointment[]> => {
      const { month, year, search, filters } = params;
      const res = await api.get<Appointment[] | Paginated<Appointment>>(
        'appointments/calendar/',
        {
          params: cleanParams({
            search,
            filters: {
              ...(filters ?? {}),
              ...(month ? { month } : {}),
              ...(year ? { year } : {}),
            },
          }),
        }
      );
      // The calendar action is a custom endpoint and is not paginated; tolerate
      // either shape so it keeps working if the backend wraps it later.
      return Array.isArray(res.data) ? res.data : res.data.results;
    },
  },

  tasks: {
    list: (params: PageParams = {}): Promise<Paginated<Task>> =>
      fetchPageMapped<RawTask, Task>('tasks/', mapTask, params),
    create: async (data: Omit<Task, 'id'>): Promise<Task> => {
      const res = await api.post<RawTask>('tasks/', {
        title: data.title,
        status: data.status,
        assigned_to: data.assignedTo,
        due_date: data.dueDate,
      });
      return mapTask(res.data);
    },
    update: async (id: string, data: Partial<Task>): Promise<Task> => {
      const res = await api.patch<RawTask>(`tasks/${id}/`, {
        title: data.title,
        status: data.status,
        assigned_to: data.assignedTo,
        due_date: data.dueDate,
      });
      return mapTask(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`tasks/${id}/`);
    },
  },

  /**
   * Notifications are READ-ONLY plus two POST actions -- the backend viewset is
   * a ReadOnlyModelViewSet, so PATCH/DELETE would return 405.
   */
  notifications: {
    list: (params: PageParams = {}): Promise<Paginated<Notification>> =>
      fetchPageMapped<RawNotification, Notification>('notifications/', mapNotification, params),
    markAsRead: async (id: string): Promise<void> => {
      await api.post(`notifications/${id}/read/`, {});
    },
    markAllAsRead: async (): Promise<void> => {
      await api.post('notifications/read-all/', {});
    },
    unreadCount: async (): Promise<number> => {
      const res = await api.get<{ count: number }>('notifications/unread-count/');
      return res.data.count;
    },
  },

  universities: {
    list: (params: PageParams = {}): Promise<Paginated<University>> =>
      fetchPage<University>('universities/', params),
    get: async (id: number | string): Promise<University> => {
      const res = await api.get<University>(`universities/${id}/`);
      return res.data;
    },
    create: async (data: UniversityInput): Promise<University> => {
      const res = await api.post<University>('universities/', data);
      return res.data;
    },
    update: async (id: number | string, data: Partial<UniversityInput>): Promise<University> => {
      const res = await api.patch<University>(`universities/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`universities/${id}/`);
    },
  },

  templates: {
    list: (params: PageParams = {}): Promise<Paginated<Template>> =>
      fetchPageMapped<RawTemplate, Template>('templates/', mapTemplate, params),
    create: async (data: Omit<Template, 'id' | 'usageCount'>): Promise<Template> => {
      const res = await api.post<RawTemplate>('templates/', {
        name: data.name,
        subject: data.subject,
        body: data.body,
        type: data.type,
        is_active: data.isActive,
      });
      return mapTemplate(res.data);
    },
    update: async (id: string, data: Partial<Template>): Promise<Template> => {
      const res = await api.patch<RawTemplate>(`templates/${id}/`, {
        name: data.name,
        subject: data.subject,
        body: data.body,
        type: data.type,
        is_active: data.isActive,
      });
      return mapTemplate(res.data);
    },
    delete: async (id: string): Promise<void> => {
      await api.delete(`templates/${id}/`);
    },
  },

  commissions: {
    list: (params: PageParams = {}): Promise<Paginated<Commission>> =>
      fetchPageMapped<RawCommission, Commission>('commissions/', mapCommission, params),
    create: async (data: Omit<Commission, 'id'>): Promise<Commission> => {
      const res = await api.post<RawCommission>('commissions/', {
        status: data.status,
        agent_name: data.agentName,
        student_name: data.studentName,
        enrollment_no: data.enrollmentNo,
        enrollment_fee: data.enrollmentFee,
        commission_amount: data.commissionAmount,
        enrollment_date: data.enrollmentDate,
      });
      return mapCommission(res.data);
    },
    update: async (id: string, data: Partial<Commission>): Promise<Commission> => {
      const res = await api.patch<RawCommission>(`commissions/${id}/`, {
        status: data.status,
        agent_name: data.agentName,
        student_name: data.studentName,
        enrollment_no: data.enrollmentNo,
        enrollment_fee: data.enrollmentFee,
        commission_amount: data.commissionAmount,
      });
      return mapCommission(res.data);
    },
  },

  agents: {
    list: (params: PageParams = {}): Promise<Paginated<Agent>> =>
      fetchPageMapped<RawAgent, Agent>('agents/', mapAgent, params),
    create: async (data: Omit<Agent, 'id'>): Promise<Agent> => {
      const res = await api.post<RawAgent>('agents/', {
        name: data.name,
        email: data.email,
        phone: data.phone,
        status: data.status,
        commission_type: data.commissionType,
        commission_value: data.commissionValue,
        total_earned: data.totalEarned,
        pending_amount: data.pendingAmount,
        students_referred: data.studentsReferred,
      });
      return mapAgent(res.data);
    },
  },

  refunds: {
    list: (params: PageParams = {}): Promise<Paginated<Refund>> =>
      fetchPage<Refund>('refunds/', params),
    /**
     * `student` (FK to Registration) is REQUIRED by the serializer.
     *
     * This previously took `Omit<Refund,'id'|'created_at'>`, whose Refund type
     * had no `student` at all — so every call posted `student_name`, which the
     * serializer ignores as read-only, and omitted the required FK. Every
     * refund creation returned 400.
     */
    create: async (data: RefundInput): Promise<Refund> => {
      const res = await api.post<Refund>('refunds/', data);
      return res.data;
    },
    update: async (id: number | string, data: Partial<RefundInput>): Promise<Refund> => {
      const res = await api.patch<Refund>(`refunds/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`refunds/${id}/`);
    },
  },

  /**
   * The discussion thread on a follow-up.
   *
   * Flat (no replies) and append-only — the API returns 403 on PATCH. Delete
   * is likewise refused, so a correction is made by adding a new comment
   * rather than rewriting the record.
   */
  followUpComments: {
    list: (followUpId: string | number, params: PageParams = {}): Promise<Paginated<FollowUpComment>> =>
      fetchPage<FollowUpComment>('follow-up-comments/', {
        ...params,
        filters: { ...(params.filters ?? {}), follow_up: followUpId },
      }),
    create: async (data: { follow_up: string | number; comment: string }): Promise<FollowUpComment> => {
      const res = await api.post<FollowUpComment>('follow-up-comments/', data);
      return res.data;
    },
  },

  /**
   * Running commentary on a student's file. Append-only server-side: the API
   * rejects PATCH, because a remark records what was believed at the time.
   */
  studentRemarks: {
    list: (registrationId: string | number, params: PageParams = {}): Promise<Paginated<StudentRemark>> =>
      fetchPage<StudentRemark>('student-remarks/', {
        ...params,
        // Exact-match filters go through `filters` so they are serialised the
        // way DjangoFilterBackend expects; a stray top-level key would be
        // silently dropped and return every remark in scope.
        filters: { ...(params.filters ?? {}), registration: registrationId },
      }),
    create: async (data: { registration: string | number; remark: string }): Promise<StudentRemark> => {
      const res = await api.post<StudentRemark>('student-remarks/', data);
      return res.data;
    },
  },

  /**
   * Custody of a student's ORIGINAL physical documents.
   *
   * Distinct from `documents`, which holds uploaded scans. This tracks the
   * paper the consultancy is physically holding and liable to return.
   */
  studentDocuments: {
    list: (registrationId?: string | number, params: PageParams = {}): Promise<Paginated<StudentDocument>> =>
      fetchPage<StudentDocument>(
        'student-documents/',
        registrationId
          ? { ...params, filters: { ...(params.filters ?? {}), registration: registrationId } }
          : params,
      ),
    create: async (data: StudentDocumentInput): Promise<StudentDocument> => {
      const res = await api.post<StudentDocument>('student-documents/', data);
      return res.data;
    },
    update: async (id: string | number, data: Partial<StudentDocumentInput>): Promise<StudentDocument> => {
      const res = await api.patch<StudentDocument>(`student-documents/${id}/`, data);
      return res.data;
    },
    delete: async (id: string | number): Promise<void> => {
      await api.delete(`student-documents/${id}/`);
    },
    /**
     * Hand a batch of originals back to the student.
     *
     * Returns `{returned, requested}` — these differ when an id was outside
     * the caller's scope or already returned, so report `returned`, never
     * `requested`, or the UI will claim work it did not do.
     */
    returnDocs: async (documentIds: Array<string | number>): Promise<StudentDocumentReturnResult> => {
      const res = await api.post<StudentDocumentReturnResult>(
        'student-documents/return-docs/',
        { document_ids: documentIds },
      );
      return res.data;
    },
  },

  visaTracking: {
    list: (params: PageParams = {}): Promise<Paginated<VisaTracking>> =>
      fetchPageMapped<RawVisaTracking, VisaTracking>('visa-tracking/', mapVisaTracking, params),
    create: async (data: Omit<VisaTracking, 'id'>): Promise<VisaTracking> => {
      const res = await api.post<RawVisaTracking>('visa-tracking/', {
        country: data.country,
        status: data.status,
        student_name: data.studentName,
        passport_no: data.passportNo,
        visa_type: data.visaType,
        applied_date: data.appliedDate,
        current_stage: data.currentStage,
        interview_date: data.interviewDate,
        expected_decision: data.expectedDecision,
      });
      return mapVisaTracking(res.data);
    },
    update: async (id: string, data: Partial<VisaTracking>): Promise<VisaTracking> => {
      const res = await api.patch<RawVisaTracking>(`visa-tracking/${id}/`, {
        country: data.country,
        status: data.status,
        student_name: data.studentName,
        passport_no: data.passportNo,
        visa_type: data.visaType,
        current_stage: data.currentStage,
        interview_date: data.interviewDate,
        expected_decision: data.expectedDecision,
      });
      return mapVisaTracking(res.data);
    },
  },

  followUps: {
    list: (params: PageParams = {}): Promise<Paginated<FollowUp>> =>
      fetchPage<FollowUp>('follow-ups/', params),
    get: async (id: number | string): Promise<FollowUp> => {
      const res = await api.get<FollowUp>(`follow-ups/${id}/`);
      return res.data;
    },
    /** `enquiry` is the enquiry FK id -- there is no student_name field here. */
    create: async (data: FollowUpInput): Promise<FollowUp> => {
      const res = await api.post<FollowUp>('follow-ups/', data);
      return res.data;
    },
    update: async (id: number | string, data: Partial<FollowUpInput>): Promise<FollowUp> => {
      const res = await api.patch<FollowUp>(`follow-ups/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`follow-ups/${id}/`);
    },
  },

  signupRequests: {
    list: (params: PageParams = {}): Promise<Paginated<SignupRequest>> =>
      fetchPageMapped<RawSignupRequest, SignupRequest>('signup-requests/', mapSignupRequest, params),
    /**
     * Approval provisions the company, admin user and subscription server-side.
     * A PATCH of `status` does NOT do that -- use these actions.
     */
    approve: async (id: string): Promise<SignupRequest> => {
      const res = await api.post<RawSignupRequest>(`signup-requests/${id}/approve/`, {});
      return mapSignupRequest(res.data);
    },
    reject: async (id: string, reason?: string): Promise<SignupRequest> => {
      const res = await api.post<RawSignupRequest>(`signup-requests/${id}/reject/`, { reason });
      return mapSignupRequest(res.data);
    },
  },

  users: {
    list: (params: PageParams = {}): Promise<Paginated<User>> => fetchPage<User>('users/', params),
    me: async (): Promise<User> => {
      const res = await api.get<User>('users/me/');
      return res.data;
    },
    get: async (id: number | string): Promise<User> => {
      const res = await api.get<User>(`users/${id}/`);
      return res.data;
    },
    /**
     * Admin staff creation. Goes through `UserAdminSerializer`, where `role`,
     * `branch` and `managed_managers` are writable -- the read `User` type has
     * them read-only, which is why the input type differs.
     *
     * `managed_managers` is the list of BRANCH_MANAGER ids a HEAD_MANAGER
     * oversees; it is the only way to express that relationship.
     * `company` is always stamped server-side from the caller.
     */
    create: async (data: UserAdminInput): Promise<User> => {
      const res = await api.post<User>('users/', data);
      return res.data;
    },
    /** Admin edit. Same admin serializer as `create`, so role/branch are writable. */
    update: async (id: number | string, data: Partial<UserAdminInput>): Promise<User> => {
      const res = await api.patch<User>(`users/${id}/`, data);
      return res.data;
    },
    /**
     * Enables or disables a staff account.
     *
     * Flips `is_active_employee` (which blocks login and fails the
     * IsAuthenticatedAndActive permission), NOT Django's `is_active`.
     * The backend rejects deactivating your own account with 400, so disable
     * that row in the UI.
     */
    setActive: async (id: number | string, isActive: boolean): Promise<User> => {
      const res = await api.post<User>(`users/${id}/set-active/`, { is_active: isActive });
      return res.data;
    },
    /**
     * Changes the signed-in user's own password.
     *
     * `current_password` is verified server-side and `new_password` runs
     * through Django's validators, so both come back as field errors -- use
     * `getApiFieldErrors` to map them onto the form.
     */
    changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
      await api.post('users/change-password/', {
        current_password: currentPassword,
        new_password: newPassword,
      });
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`users/${id}/`);
    },
  },

  companies: {
    list: (params: PageParams = {}): Promise<Paginated<Company>> =>
      fetchPage<Company>('companies/', params),
    get: async (id: number | string): Promise<Company> => {
      const res = await api.get<Company>(`companies/${id}/`);
      return res.data;
    },
    create: async (data: CompanyInput): Promise<Company> => {
      const res = await api.post<Company>('companies/', data);
      return res.data;
    },
    /**
     * Only `name`, `email`, `phone`, `address` and `is_active` are writable.
     * The model has no website/currency/timezone columns.
     */
    update: async (id: number | string, data: Partial<CompanyInput>): Promise<Company> => {
      const res = await api.patch<Company>(`companies/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`companies/${id}/`);
    },
    /** The signed-in user's company, or null when they have none (DEV_ADMIN). */
    getCurrent: async (): Promise<Company | null> => {
      const page = await fetchPage<Company>('companies/', { page_size: 1 });
      return page.results[0] ?? null;
    },
  },

  branches: {
    list: (params: PageParams = {}): Promise<Paginated<Branch>> =>
      fetchPage<Branch>('branches/', params),
    get: async (id: number | string): Promise<Branch> => {
      const res = await api.get<Branch>(`branches/${id}/`);
      return res.data;
    },
    create: async (data: Partial<Branch>): Promise<Branch> => {
      const res = await api.post<Branch>('branches/', data);
      return res.data;
    },
    update: async (id: number | string, data: Partial<Branch>): Promise<Branch> => {
      const res = await api.patch<Branch>(`branches/${id}/`, data);
      return res.data;
    },
    delete: async (id: number | string): Promise<void> => {
      await api.delete(`branches/${id}/`);
    },
  },

  /** Read-only server-side (ReadOnlyModelViewSet); writes are not exposed. */
  plans: {
    list: (params: PageParams = {}): Promise<Paginated<Plan>> => fetchPage<Plan>('plans/', params),
    get: async (id: number | string): Promise<Plan> => {
      const res = await api.get<Plan>(`plans/${id}/`);
      return res.data;
    },
  },

  /** Read-only server-side. Billing changes happen out of band, not via PATCH. */
  subscriptions: {
    list: (params: PageParams = {}): Promise<Paginated<Subscription>> =>
      fetchPage<Subscription>('subscriptions/', params),
    get: async (id: number | string): Promise<Subscription> => {
      const res = await api.get<Subscription>(`subscriptions/${id}/`);
      return res.data;
    },
    /** The signed-in user's company subscription, or null if none. */
    mine: async (): Promise<Subscription | null> => {
      const res = await api.get<Subscription | null>('subscriptions/mine/');
      return res.data;
    },
  },

  /** Record ownership transfers (see `DocumentTransfer` for physical documents). */
  transfers: {
    list: (params: PageParams = {}): Promise<Paginated<RecordTransfer>> =>
      fetchPage<RecordTransfer>('transfers/', params),
    get: async (id: number | string): Promise<RecordTransfer> => {
      const res = await api.get<RecordTransfer>(`transfers/${id}/`);
      return res.data;
    },
    /** `from_user`, `status` and `entity_label` are assigned server-side. */
    create: async (data: {
      entity_type: string;
      entity_id: number;
      to_user: number;
      note?: string;
    }): Promise<RecordTransfer> => {
      const res = await api.post<RecordTransfer>('transfers/', data);
      return res.data;
    },
    /** Pending transfers addressed to the signed-in user. */
    inbox: (params: PageParams = {}): Promise<Paginated<RecordTransfer>> =>
      fetchPage<RecordTransfer>('transfers/inbox/', params),
    /** Only the recipient may accept. Applies the ownership change. */
    accept: async (id: number | string): Promise<RecordTransfer> => {
      const res = await api.post<RecordTransfer>(`transfers/${id}/accept/`, {});
      return res.data;
    },
    /** Only the recipient may reject. */
    reject: async (id: number | string): Promise<RecordTransfer> => {
      const res = await api.post<RecordTransfer>(`transfers/${id}/reject/`, {});
      return res.data;
    },
  },

  /** Document custody transfers. */
  documentTransfers: {
    list: (params: PageParams = {}): Promise<Paginated<DocumentTransfer>> =>
      fetchPage<DocumentTransfer>('document-transfers/', params),
  },

  /**
   * Analytics. Six endpoints, none paginated, all role-scoped server-side.
   * These are the only `analytics/*` paths the backend exposes.
   */
  analytics: {
    getOverview: async (): Promise<AnalyticsOverview> => {
      const res = await api.get<AnalyticsOverview>('analytics/overview/');
      return res.data;
    },
    getFunnel: async (): Promise<AnalyticsFunnel> => {
      const res = await api.get<AnalyticsFunnel>('analytics/funnel/');
      return res.data;
    },
    /** @param months trailing window, default 12 server-side. */
    getRevenue: async (months?: number): Promise<RevenuePoint[]> => {
      const res = await api.get<{ series: RevenuePoint[] }>('analytics/revenue/', {
        params: months ? { months } : {},
      });
      return res.data.series;
    },
    /** Per-branch comparison. Empty for roles that manage no branches. */
    getBranches: async (): Promise<BranchAnalyticsRow[]> => {
      const res = await api.get<BranchAnalyticsRow[]>('analytics/branches/');
      return res.data;
    },
    getVisaPipeline: async (): Promise<VisaPipeline> => {
      const res = await api.get<VisaPipeline>('analytics/visa-pipeline/');
      return res.data;
    },
    getSources: async (): Promise<SourceAnalyticsRow[]> => {
      const res = await api.get<SourceAnalyticsRow[]>('analytics/sources/');
      return res.data;
    },
  },

  /**
   * Personal API keys for MCP/AI clients and scripts. A key acts as the
   * signed-in user; the plaintext is only ever present on the create response.
   * The endpoint refuses sessions authenticated BY a key, so this is only
   * reachable from a password login.
   */
  apiKeys: {
    list: (params: PageParams = {}): Promise<Paginated<ApiKey>> => fetchPage<ApiKey>('api-keys/', params),
    create: async (name: string, expiresAt?: string | null): Promise<ApiKeyCreated> => {
      const res = await api.post<ApiKeyCreated>('api-keys/', {
        name,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
      return res.data;
    },
    revoke: async (id: number): Promise<ApiKey> => {
      const res = await api.post<ApiKey>(`api-keys/${id}/revoke/`);
      return res.data;
    },
  },

  /**
   * The role x capability grid.
   *
   * NOT a paginated collection: the whole matrix arrives in one response,
   * because that is what the screen renders and because a per-cell endpoint
   * would turn one save into sixty round trips. `fetchPage` is deliberately
   * not used here — there is no envelope.
   */
  rolePermissions: {
    /** @param company DEV_ADMIN only; ignored for everyone else, who is pinned
     *  to their own tenant server-side. */
    get: async (company?: number | null): Promise<PermissionMatrix> => {
      const res = await api.get<PermissionMatrix>('role-permissions/', {
        params: company ? { company } : {},
      });
      return res.data;
    },
    /**
     * Applies a batch atomically and returns the re-rendered grid, so the
     * screen never has to guess what the server made of its request — a
     * refused cell would otherwise leave the toggle showing a value that was
     * never saved.
     */
    update: async (
      changes: PermissionChange[],
      company?: number | null
    ): Promise<PermissionMatrix> => {
      const res = await api.put<PermissionMatrix>('role-permissions/', {
        changes,
        ...(company ? { company } : {}),
      });
      return res.data;
    },
    /** Drops every override and returns to the built-in defaults. */
    reset: async (company?: number | null): Promise<PermissionMatrix> => {
      const res = await api.delete<PermissionMatrix>('role-permissions/', {
        params: company ? { company } : {},
      });
      return res.data;
    },
    /** What the signed-in user's own role currently holds. */
    mine: async (): Promise<MyCapabilities> => {
      const res = await api.get<MyCapabilities>('role-permissions/mine/');
      return res.data;
    },
  },

  approvalRequests: {
    list: (params: PageParams = {}): Promise<Paginated<ApprovalRequest>> =>
      fetchPage<ApprovalRequest>('approval-requests/', params),
    create: async (data: {
      action: ApprovalRequest['action'];
      entity_type: string;
      entity_id: number;
      entity_name: string;
      message: string;
    }): Promise<ApprovalRequest> => {
      const res = await api.post<ApprovalRequest>('approval-requests/', data);
      return res.data;
    },
    /**
     * Requests raised BY the caller, as opposed to ones awaiting their review.
     *
     * A manager's queryset legitimately contains both, so the plain list cannot
     * distinguish "my requests" from "my inbox".
     */
    myRequests: (params: PageParams = {}): Promise<Paginated<ApprovalRequest>> =>
      fetchPage<ApprovalRequest>('approval-requests/my-requests/', params),

    pendingCount: async (): Promise<number> => {
      const res = await api.get<{ count: number }>('approval-requests/pending-count/');
      return res.data.count;
    },
    approve: async (id: number, note?: string): Promise<ApprovalRequest> => {
      const res = await api.post<ApprovalRequest>(`approval-requests/${id}/approve/`, {
        review_note: note,
      });
      return res.data;
    },
    reject: async (id: number, note: string): Promise<ApprovalRequest> => {
      const res = await api.post<ApprovalRequest>(`approval-requests/${id}/reject/`, {
        review_note: note,
      });
      return res.data;
    },
  },
};



