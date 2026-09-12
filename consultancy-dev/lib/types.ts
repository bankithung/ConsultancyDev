/**
 * Shared domain types.
 *
 * Naming convention in this file mirrors the transport it describes: fields that
 * come straight off the DRF serializers keep their snake_case names, while types
 * that are re-mapped in `lib/apiClient.ts` use camelCase.
 */

export const ROLES = [
  'DEV_ADMIN',
  'COMPANY_ADMIN',
  'HEAD_MANAGER',
  'BRANCH_MANAGER',
  'EMPLOYEE',
] as const;

export type Role = (typeof ROLES)[number];

/** Narrowing guard for values arriving from JWT claims or untyped API payloads. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Envelope returned by every list endpoint. The backend paginates all
 * collections; there are no bare-array list responses.
 */
/**
 * A dated, attributed note on a student's file. Append-only — the API rejects
 * edits, so treat these as an immutable log rather than editable content.
 */
export interface StudentRemark {
  id: number;
  registration: number;
  user: number | null;
  user_name: string;
  remark: string;
  created_at: string;
  company_name?: string;
  branch_name?: string;
}

/** Custody status of an ORIGINAL physical document held by the consultancy. */
export type StudentDocumentStatus =
  | 'Received'
  | 'With staff'
  | 'Submitted'
  | 'Returned'
  | 'Lost';

/**
 * A student's ORIGINAL paper document (passport, degree certificate) that the
 * consultancy physically holds. Distinct from `Document`, which is an uploaded
 * scan. `current_holder` answers "who has it right now" — the question that
 * matters when a student asks for it back.
 */
export interface StudentDocument {
  id: number;
  registration: number;
  student_name: string;
  name: string;
  document_number: string;
  status: StudentDocumentStatus;
  received_at: string;
  returned_at: string | null;
  remarks: string;
  current_holder: number | null;
  current_holder_name: string;
  created_by_name: string;
  branch_name?: string;
}

export interface StudentDocumentInput {
  registration: number | string;
  name: string;
  document_number?: string;
  status?: StudentDocumentStatus;
  remarks?: string;
  current_holder?: number | null;
}

/**
 * Result of a bulk return. `returned` and `requested` differ when an id was
 * out of scope or already returned — always surface `returned`.
 */
export interface StudentDocumentReturnResult {
  returned: number;
  requested: number;
  ids: number[];
}

export interface Paginated<T> {
  count: number;
  pages: number;
  page: number;
  page_size: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Query parameters accepted by every list endpoint.
 *
 * `page_size` is capped at 200 server-side (default 25).
 */
export interface PageParams {
  page?: number;
  page_size?: number;
  /** Free-text search across the endpoint's `search_fields`. */
  search?: string;
  /** e.g. `-created_at`. Only fields in the endpoint's `ordering_fields`. */
  ordering?: string;
  /**
   * Field filters (DjangoFilterBackend), e.g. `{status: 'Pending'}`.
   *
   * An array means "any of these" and goes out as repeated query parameters.
   * Only endpoints backed by a FilterSet accept several values -- everywhere
   * else the extra ones are ignored, so check the backend first.
   *
   * Only fields the endpoint declares are honoured; anything else is silently
   * ignored and you get unfiltered data back. Currently supported:
   *   users        role, branch, is_active_employee
   *   enquiries    status, stream, course_interested, gender, caste,
   *                school_board, family_state, preferred_locations, branch,
   *                owner, created_by  -- all multi-value (core/filters.py)
   *   registrations branch, owner, payment_status
   *   enrollments  status, branch, country, owner
   *   payments     status, type, branch, method
   *   follow-ups   status, priority, type, outcome_status,
   *                admission_possibility, assigned_to, enquiry, branch, owner
   *   appointments status, type, counselor, branch, owner, created_by
   *                -- honoured by `appointments/calendar/` too
   */
  filters?: Record<string, string | number | boolean | readonly string[]>;
}

/**
 * Fields the backend's `ScopedSerializer` adds to every tenant-owned record.
 *
 * All server-owned and read-only: `company`, `branch`, `created_by`, `owner`,
 * `created_at` and `updated_at` are stamped from the request user, so sending
 * them is silently ignored. The `*_name` labels render as '—' rather than null
 * when the relation is empty, so they are always strings.
 */
// NOTE: `ScopedFields` is declared once, further down this file, with every
// member OPTIONAL. A second, all-required copy lived here and produced TS2687
// on every member ("all declarations must have identical modifiers"), which
// then broke every type extending it.
//
// Optional is the correct choice even though the server always sends these:
// the wire mappers build their result by spreading a `Raw*` object that does
// not carry them, so requiring them makes every mapper fail to type-check.

/** Error body returned by the API for 4xx/5xx responses. */
export interface ApiErrorBody {
  error: string;
  fields?: Record<string, string[] | string>;
}

/**
 * Mirrors the backend `UserSerializer`.
 *
 * `role`, `company` and `branch` are READ-ONLY on this serializer -- they are
 * only assignable through the admin create/update paths (see `UserAdminInput`).
 * Patching `role` from a normal profile update is rejected server-side.
 */
export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  /** Server-composed display name, falling back to username. */
  full_name: string;
  role: Role;
  /** Human-readable role label from Django's `get_role_display`. */
  role_display: string;
  company: number | null;
  company_name: string | null;
  branch: number | null;
  branch_name: string | null;
  phone: string | null;
  avatar: string | null;
  is_active: boolean;
  /** False for a deactivated employee; such accounts are refused at login. */
  is_active_employee: boolean;
  last_login: string | null;
  /**
   * Branch managers this head manager oversees. Read-only here; the admin
   * sets it on the user form. Empty for every other role.
   */
  managed_managers?: number[];
}

/**
 * Admin-only write shape (`UserAdminSerializer`), where role and branch ARE
 * writable. `managed_managers` assigns branch managers to a head manager.
 */
export interface UserAdminInput {
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  password?: string;
  role: Role;
  branch?: number | null;
  phone?: string;
  managed_managers?: number[];
}

/* -------------------------------------------------------------------------- */
/* Role permissions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `core.models.Capability`, which is itself a copy of the `CAN` map in
 * components/rbac/roles.ts. All three have to agree: the enum is the server's
 * enforcement vocabulary, `CAN` is the client's offline default, and this type
 * is what travels between them.
 */
export type CapabilityKey =
  | 'manageCompanies'
  | 'manageBranches'
  | 'manageUsers'
  | 'viewAnalytics'
  | 'viewEarnings'
  | 'manageCommissions'
  | 'manageSettings'
  | 'reviewApprovals'
  | 'manageCounselors'
  | 'manageRefunds'
  | 'deleteRecords';

/** One cell of the roles x capabilities grid, as the server renders it. */
export interface PermissionCell {
  allowed: boolean;
  /**
   * Where `allowed` came from. `default` is the built-in rule, `override` is a
   * row this company saved, `platform` is the DEV_ADMIN column, which no tenant
   * can configure. The screen shows the difference: an admin needs to know
   * whether a value is a decision somebody made or a default nobody has
   * touched.
   */
  source: 'default' | 'override' | 'platform';
  /** Whether THIS toggle can move, in the direction it would move. */
  editable: boolean;
  can_grant: boolean;
  can_revoke: boolean;
  /** Why it cannot move. Always present when `editable` is false. */
  reason: string;
}

export interface PermissionCapabilityMeta {
  value: CapabilityKey;
  label: string;
  /** Lowest role that may ever hold it, or null when unrestricted. */
  floor: Role | null;
  /** Why the floor exists. Empty when there is no floor. */
  protection_reason: string;
  default_roles: Role[];
}

/** `GET /api/role-permissions/` — the whole grid in one response. */
export interface PermissionMatrix {
  company: number | null;
  company_name: string | null;
  roles: Array<{ value: Role; label: string }>;
  capabilities: PermissionCapabilityMeta[];
  matrix: Record<Role, Record<CapabilityKey, PermissionCell>>;
}

/**
 * One edit. `allowed: null` DELETES the override and returns the cell to its
 * built-in default — without it there would be no way back from an explicit
 * choice.
 */
export interface PermissionChange {
  role: Role;
  capability: CapabilityKey;
  allowed: boolean | null;
}

/** `GET /api/role-permissions/mine/` — what the signed-in user's role holds. */
export interface MyCapabilities {
  role: Role;
  capabilities: CapabilityKey[];
}

/**
 * Mirrors `CompanySerializer`.
 *
 * Text fields are `blank=True, default=''` on the model, so they arrive as
 * empty strings rather than null.
 */
export interface Company {
  id: number;
  name: string;
  /** Server-generated from `name`; read-only. */
  slug: string;
  email: string;
  phone: string;
  address: string;
  is_active: boolean;
  /** Nested read-only object. Null when the company has no subscription yet. */
  subscription: Subscription | null;
  branch_count: number;
  user_count: number;
  created_at: string;
}

/**
 * Writable fields on a company.
 *
 * Deliberately narrow: `slug`, `created_at`, `subscription`, `branch_count` and
 * `user_count` are read-only server-side and would be silently discarded.
 * There is NO `website`, `currency` or `timezone` on the Company model -- do
 * not add inputs for them, they would drop whatever the user typed.
 */
export interface CompanyInput {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  is_active?: boolean;
}

/**
 * Mirrors `BranchSerializer`.
 *
 * There is NO manager foreign key on Branch. Branch managers are Users with
 * `role: 'BRANCH_MANAGER'` and `branch: <id>`, which is why the serializer
 * exposes `manager_names` as a computed list -- assign managers from the users
 * endpoint, not from here.
 */
export interface Branch {
  id: number;
  company: number;
  company_name: string;
  name: string;
  code: string;
  city: string;
  address: string;
  phone: string;
  is_active: boolean;
  /** Receives records created before branches existed. Read-only. */
  is_default: boolean;
  user_count: number;
  /** Display names of users with role BRANCH_MANAGER in this branch. */
  manager_names: string[];
  created_at: string;
}

/** Mirrors `PlanSerializer`. */
export interface Plan {
  id: number;
  name: string;
  slug: string;
  price_monthly: number;
  /** ISO 4217 code, e.g. 'INR'. */
  currency: string;
  /** 0 means unlimited. */
  max_branches: number;
  /** 0 means unlimited. */
  max_users: number;
  /** JSONField with `default=dict` -- an object, not an array. */
  features: Record<string, unknown>;
  is_active: boolean;
  sort_order: number;
}

export type SubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * Mirrors `SubscriptionSerializer`. Billing periods, not start/end dates --
 * there is no `amount` or `auto_renew` on the wire.
 */
export interface Subscription {
  id: number;
  company: number;
  company_name: string;
  plan: number;
  plan_name: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string | null;
  cancelled_at: string | null;
  days_remaining: number;
  /** Whether the tenant may currently write data. Gates the UI, not just billing. */
  is_usable: boolean;
}

export type RecordTransferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';

/**
 * Transfer of an owned record (enquiry, registration, enrollment, …) to another
 * user. Distinct from `DocumentTransfer`, which moves physical document
 * custody. Field names mirror `RecordTransferSerializer` exactly.
 */
export interface RecordTransfer {
  id: number;
  entity_type: string;
  entity_id: number;
  /** Server-rendered label for the transferred record. Read-only. */
  entity_label: string | null;
  from_user: number;
  from_user_name: string;
  to_user: number;
  to_user_name: string;
  note: string;
  status: RecordTransferStatus;
  requires_acceptance: boolean;
  created_at: string;
  resolved_at: string | null;
}

/** Wire values of `Enquiry.Status` on the Django model. */
export type EnquiryStatus = 'New' | 'Contacted' | 'Converted' | 'Closed';

export interface Enquiry extends ScopedFields {
  id: string;
  date: string; // ISO date
  schoolName: string;
  /** The API accepts free text, including subject combinations such as PCB. */
  stream: string;
  candidateName: string;
  courseInterested: string;
  mobile: string;
  email: string;
  fatherName: string;
  motherName: string;
  fatherOccupation?: string;
  motherOccupation?: string;
  fatherMobile?: string;
  motherMobile?: string;
  permanentAddress: string;
  preferredLocations: string[];
  otherLocation?: string;
  status: EnquiryStatus;

  /**
   * Academic and eligibility profile.
   *
   * Every one of these has a column and a serializer field; they read as
   * `undefined` only when nobody filled them in. Numbers are declared as
   * `number | string` because DRF renders DecimalField as a string by default.
   */
  gender?: string;
  /** Encrypted at rest server-side; plain ISO date over the wire. */
  dateOfBirth?: string | null;
  caste?: string;
  religion?: string;
  familyPlace?: string;
  familyState?: string;
  schoolBoard?: string;
  schoolPlace?: string;
  schoolState?: string;
  class12PassingYear?: string;
  class12Percentage?: number | string | null;
  class10SchoolName?: string;
  class10Board?: string;
  class10PassingYear?: string;
  class10Place?: string;
  class10State?: string;
  class10Percentage?: number | string | null;
  physicsMarks?: number | string | null;
  chemistryMarks?: number | string | null;
  biologyMarks?: number | string | null;
  mathsMarks?: number | string | null;
  pcbPercentage?: number | string | null;
  pcmPercentage?: number | string | null;
  previousNeetMarks?: number | string | null;
  presentNeetMarks?: number | string | null;
  gapYear: boolean;
  gapYearFrom?: number | null;
  gapYearTo?: number | null;
  collegeDropout: boolean;
  paymentAmount?: number | string | null;
}

/**
 * Fields every tenant-scoped record carries. The serializers return all of
 * these; the types omitted them, so "assigned to" columns and the transfer
 * button had nothing to read even though the data was arriving.
 */
export interface ScopedFields {
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

export interface Registration extends ScopedFields {
  id: string;
  /** Server-assigned when omitted on create (e.g. REG-2026-004). */
  registrationNo: string;
  studentName: string;
  mobile: string;
  email: string;
  registrationDate: string;
  needsLoan: boolean;
  paymentStatus: 'Paid' | 'Pending' | 'Partial' | string;
  paymentMethod: 'Cash' | 'Card' | 'UPI' | 'Bank Transfer' | 'Cheque' | 'Other' | string;
  registrationFee: number;
  fatherName: string;
  motherName: string;
  permanentAddress: string;
  preferences: StudyPreference[];
  /** Encrypted at rest server-side; plain ISO date over the wire. */
  date_of_birth?: string | null;
  /** FK back to the enquiry this was converted from. */
  enquiry?: number | null;
  enquiry_candidate?: string;

  /**
   * Student profile, mirroring Enquiry so a conversion carries details forward.
   *
   * These are REAL COLUMNS now. Until this migration the registration form's
   * gender/caste/religion/schooling/marks had nowhere to go and were written
   * into the append-only remarks log as free text — recorded, but not
   * filterable, reportable, correctable, or readable back into the form.
   */
  gender?: string;
  caste?: string;
  religion?: string;
  father_occupation?: string;
  mother_occupation?: string;
  father_mobile?: string;
  mother_mobile?: string;
  family_place?: string;
  family_state?: string;
  stream?: string;
  school_name?: string;
  school_board?: string;
  school_place?: string;
  school_state?: string;
  class12_passing_year?: string;
  class12_percentage?: number | null;
  class10_school_name?: string;
  class10_board?: string;
  class10_passing_year?: string;
  class10_place?: string;
  class10_state?: string;
  class10_percentage?: number | null;
  physics_marks?: number | null;
  chemistry_marks?: number | null;
  biology_marks?: number | null;
  maths_marks?: number | null;
  pcb_percentage?: number | null;
  pcm_percentage?: number | null;
  previous_neet_marks?: number | null;
  present_neet_marks?: number | null;
  gap_year?: boolean;
  gap_year_from?: number | null;
  gap_year_to?: number | null;
  college_dropout?: boolean;
}

/**
 * Write shape for a registration, using the serializer's real field names.
 *
 * `registration_no` is optional: the server allocates the next per-company
 * reference when it is omitted. It used to be required with no generator, so
 * every create that left it out returned 400.
 */
export interface RegistrationInput {
  registration_no?: string;
  student_name: string;
  mobile: string;
  email: string;
  date_of_birth?: string | null;
  father_name?: string;
  mother_name?: string;
  permanent_address?: string;
  needs_loan?: boolean;
  payment_status?: string;
  payment_method?: string;
  registration_fee: number | string;
  preferences?: unknown[];
  /** Keeps the link back to the originating enquiry. */
  enquiry?: number | string | null;

  // Student profile — all optional, all now real columns.
  gender?: string;
  caste?: string;
  religion?: string;
  father_occupation?: string;
  mother_occupation?: string;
  father_mobile?: string;
  mother_mobile?: string;
  family_place?: string;
  family_state?: string;
  stream?: string;
  school_name?: string;
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
}

export interface StudyPreference {
  courseName: string;
  location: string;
  priority: number;
}

export interface Enrollment extends ScopedFields {
  id: string;
  /** Server-assigned when omitted on create (e.g. ENR-2026-004). */
  enrollmentNo: string;
  /** FK to Registration. This is the field the serializer requires on write. */
  student: number;
  studentName: string;
  programName: string;
  startDate: string;
  durationMonths: number;
  totalFees: number;
  status: 'Active' | 'Completed' | 'Dropped' | string;
  /** FK to University, plus the free-text name for entries not in the catalogue. */
  university?: number | null;
  university_name?: string;
  country?: string;
  commission_amount?: number;
  installments?: Installment[];

  // NOTE: serviceCharge / schoolFees / hostelFees / paymentType / loanRequired
  // / loanAmount were declared here but have NO column on the server. They are
  // deliberately absent rather than typed-and-silently-dropped. If the business
  // needs a fee breakdown, it needs a backend migration first.
}

export interface EnrollmentInput {
  enrollment_no?: string;
  student: number | string;
  program_name: string;
  university?: number | string | null;
  university_name?: string;
  country?: string;
  start_date: string;
  duration_months: number;
  total_fees: number | string;
  commission_amount?: number | string;
  status?: string;
  /** Generates a payment schedule that sums exactly to `total_fees`. */
  installments_count?: number;
  installment_amount?: number | string;
}

/**
 * Nested under Enrollment. The API returns snake_case here — the previous
 * camelCase declaration meant `dueDate` was always undefined at runtime.
 */
export interface Installment {
  id?: number;
  enrollment?: number;
  number: number;
  due_date: string;
  amount: number;
  status: 'Paid' | 'Pending' | 'Overdue' | string;
  paid_at?: string | null;
}

export interface Document {
  id: string;
  fileName: string;
  type: string;
  status: 'IN' | 'OUT';
  uploadedBy: string;
  uploadedAt: string; // ISO
  studentName?: string;
  registrationNo?: string;
  /**
   * Which student this document actually belongs to. Exactly one is set, or
   * neither. `studentName` is a denormalised copy the server derives from
   * whichever link is present -- read it for display, never as the identity.
   */
  registration?: string | null;
  enquiry?: string | null;
  expiryDate?: string;
  fileSize?: number;
  mimeType?: string;
}

export interface DocumentTransfer {
  id: string;
  senderId: string;
  receiverId: string;
  documentIds: string[];
  status: 'Pending' | 'Sent' | 'Received';
  createdAt: string;
}

/** Server statuses, from `Payment.Status`. `Refunded` was missing here. */
export type PaymentStatus = 'Pending' | 'Success' | 'Failed' | 'Refunded';

export interface Payment {
  id: string;
  date: string;
  studentName: string;
  /** Free text server-side; these are the values the app actually produces. */
  type: 'Enquiry' | 'Registration' | 'Enrollment' | string;
  amount: number;
  status: PaymentStatus;
  method: 'Cash' | 'Card' | 'UPI' | 'Bank Transfer' | 'Cheque' | 'Other' | string;
  /**
   * Links back to what was paid for. The old type omitted all three, so a
   * payment could not be tied to its registration or instalment — which is
   * exactly why the previous build had to match payments to students by name.
   */
  registration?: number | null;
  enrollment?: number | null;
  installment?: number | null;
  /** Cheque number, UPI reference, transaction id. Flat string server-side. */
  reference?: string;
  /**
   * Method-specific detail the flat `reference` cannot hold. Keys used by the
   * app: cheque_no, bank, upi_id, card_last4, card_network.
   */
  metadata?: Record<string, unknown>;
  branch_name?: string;
  created_by_name?: string;
}

export interface PaymentInput {
  student_name: string;
  amount: number | string;
  type: string;
  status?: PaymentStatus;
  method?: string;
  date?: string;
  registration?: number | string | null;
  enrollment?: number | string | null;
  installment?: number | string | null;
  reference?: string;
}

export interface Task {
  id: string;
  title: string;
  assignedTo: string; // User ID or Name
  dueDate: string;
  status: 'Todo' | 'In Progress' | 'Done';
}

/**
 * A row from `GET users/counselors/`.
 *
 * A bare, non-paginated array. Covers EMPLOYEE and BRANCH_MANAGER users who are
 * active, scoped to what the caller may see. Keys are camelCase here because
 * the endpoint composes them by hand rather than through a serializer.
 */
export interface CounselorPerformance {
  id: number;
  /** Full name, falling back to username. */
  name: string;
  email: string;
  avatar: string | null;
  /** Branch NAME, not id. Null when the user has no branch. */
  branch: string | null;
  totalEnquiries: number;
  converted: number;
  registrations: number;
  enrollments: number;
  /** Percentage, one decimal. 0 when the counselor has no enquiries. */
  conversionRate: number;
}

/**
 * Mirrors `AppointmentSerializer`. Snake_case, matching the wire exactly --
 * there is no camelCase remapping layer for this resource any more.
 */
export interface Appointment extends ScopedFields {
  id: number;
  student_name: string;
  student_email: string;
  /** Counselor user id. */
  counselor: number | null;
  /** Display name, or '—' when unassigned. Read-only. */
  counselor_name: string;
  date: string;
  time: string;
  duration: number;
  type: string;
  status: string;
  notes: string;
}

/** Writable fields for creating/updating an appointment. */
export interface AppointmentInput {
  student_name: string;
  student_email?: string;
  counselor?: number | null;
  date: string;
  time: string;
  duration?: number;
  type?: string;
  status?: string;
  notes?: string;
}

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  actionUrl?: string;
  created_at: string;
}

/**
 * Mirrors `UniversitySerializer`. A shared catalogue: `company` is null for
 * globally shared entries.
 *
 * NOTE: the program list is `programs`, NOT `courses` -- there is no `courses`
 * field anywhere on the wire. There is also no `website`.
 */
export interface University {
  id: number;
  company: number | null;
  name: string;
  country: string;
  city: string;
  ranking: number | null;
  /** JSONField(default=list). */
  programs: string[];
  tuition_fee_min: number;
  tuition_fee_max: number;
  admission_deadline: string;
  /** JSONField(default=list). */
  requirements: string[];
  rating: number;
}

/** Writable fields for creating/updating a university. `company` is server-set. */
export interface UniversityInput {
  name: string;
  country: string;
  city?: string;
  ranking?: number | null;
  programs?: string[];
  tuition_fee_min?: number;
  tuition_fee_max?: number;
  admission_deadline?: string;
  requirements?: string[];
  rating?: number;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  type: string;
  isActive: boolean;
  usageCount: number;
}

export interface Commission {
  id: string;
  agentName: string;
  studentName: string;
  enrollmentNo: string;
  enrollmentFee: number;
  commissionAmount: number;
  enrollmentDate: string;
  status: 'Pending' | 'Paid';
}

export interface Agent {
  id: string;
  name: string;
  email: string;
  phone?: string;
  commissionType: 'Percentage' | 'Fixed';
  commissionValue: number;
  totalEarned: number;
  pendingAmount: number;
  studentsReferred: number;
  status: 'Active' | 'Inactive';
}

/**
 * Server statuses, from `Refund.Status` in backend/core/models.py.
 * These are wire values — keep any human label separate.
 */
export type RefundStatus = 'Pending' | 'Approved' | 'Processed' | 'Rejected';

export interface Refund {
  id: string;
  /** FK to Registration. REQUIRED on write. */
  student: number;
  /** Read-only, from `student.student_name`. Sending it on write is ignored. */
  student_name: string;
  /** FK to Payment being refunded. Nullable. */
  payment: number | null;
  amount: number;
  reason: string;
  status: RefundStatus;
  processed_at: string | null;
  created_at: string;
  branch_name?: string;
  created_by_name?: string;
}

/**
 * Write shape for a refund.
 *
 * `student` was missing from the old `Refund` type, and the client posted
 * `student_name` instead — which the serializer ignores, because it is
 * read-only. Every refund POST therefore failed validation on the missing
 * required FK.
 */
export interface RefundInput {
  student: number | string;
  payment?: number | string | null;
  amount: number | string;
  reason?: string;
  status?: RefundStatus;
}

export interface VisaTracking {
  id: string;
  studentName: string;
  passportNo: string;
  visaType: string;
  country: string;
  appliedDate: string;
  currentStage: string;
  interviewDate?: string;
  expectedDecision?: string;
  status: string;
}

/**
 * Mirrors `FollowUpSerializer`.
 *
 * `type`, `status` and `priority` are free CharFields with defaults ('Call',
 * 'Pending', 'Medium') and no model-level choices, so they are typed as plain
 * strings rather than unions -- the backend accepts any value.
 */
export interface FollowUp extends ScopedFields {
  id: number;
  /** Enquiry FK. This is the field to SEND when creating. */
  enquiry: number;
  /** Candidate name from the linked enquiry. Read-only. */
  enquiry_candidate: string;
  assigned_to: number | null;
  /** Display name, or '—' when unassigned. Read-only. */
  assigned_to_name: string;
  scheduled_for: string;
  type: string;
  status: string;
  priority: string;
  notes: string;
  completed_at: string | null;
  /** What actually happened on the call. Empty string until recorded. */
  outcome_status: FollowUpOutcome | '';
  /** How likely this lead is to convert. Empty string until recorded. */
  admission_possibility: AdmissionLikelihood | '';
}

/** Writable fields for creating/updating a follow-up. */
/** Wire values from `FollowUp.Outcome` in backend/core/models.py. */
export type FollowUpOutcome =
  | 'Not reached'
  | 'Interested'
  | 'Thinking'
  | 'Not interested'
  | 'Converted';

/**
 * Wire values from `FollowUp.Likelihood`. This is a FOUR-VALUE choice, not a
 * 0-100 scale — rendering it as a slider would misrepresent the data.
 */
export type AdmissionLikelihood = 'High' | 'Medium' | 'Low' | 'Unknown';

export interface FollowUpInput {
  enquiry: number;
  assigned_to?: number | null;
  scheduled_for: string;
  type?: string;
  status?: string;
  priority?: string;
  notes?: string;
  completed_at?: string | null;
  outcome_status?: FollowUpOutcome | '';
  admission_possibility?: AdmissionLikelihood | '';
}

/**
 * A message on a follow-up's thread.
 *
 * FLAT — there is no `parent_comment`, so no replies. Append-only: the API
 * returns 403 on PATCH, because a comment records what was said at the time.
 */
export interface FollowUpComment extends ScopedFields {
  id: number;
  follow_up: number;
  author: number | null;
  /** Display name, or '—'. Stamped from the request server-side; read-only. */
  author_name: string;
  comment: string;
  created_at: string;
}

export interface SignupRequest {
  id: string;
  username: string;
  email: string;
  companyName: string;
  adminName: string;
  phone?: string;
  plan: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestedAt: string;
}

export interface ReportMetrics {
  enquiriesCount: number;
  registrationsCount: number;
  enrollmentsCount: number;
  /**
   * Sum of pending payment AMOUNTS (currency), not a row count -- this is what
   * `analytics/overview/` reports. Named explicitly so it is not mistaken for
   * the count the old bare-array dashboard used to compute.
   */
  pendingPaymentsAmount: number;
  /** Transfers awaiting the signed-in user's acceptance. */
  pendingTransfers: number;
}

export interface ApprovalRequest {
  id: number;
  action: 'DELETE' | 'UPDATE';
  entity_type: string;
  entity_id: number;
  entity_name: string;
  message: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  review_note?: string;
  requested_by: number;
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: number;
  pending_changes?: Record<string, unknown>;
}

/** Mirrors `ApiKeySerializer`. The hash is never sent; `prefix` identifies a key in lists. */
export interface ApiKey {
  id: number;
  user: number;
  user_name: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_valid: boolean;
}

/** The create response: the plaintext `key` is returned exactly once. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}
