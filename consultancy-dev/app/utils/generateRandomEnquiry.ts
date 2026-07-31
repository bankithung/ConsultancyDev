/**
 * Demo autofill for the enquiry form.
 *
 * Ported from the kikonsDev build, where it lived in `app/utils/` alongside a
 * separate `app/data/mockEnquiryData` module. The name lists are inlined here
 * so the helper is self-contained — they exist only to make a demo record look
 * plausible and are not shared with anything else.
 *
 * Every key returned matches a field name in `EnquiryForm`'s zod schema, so the
 * form can `setValue` each one directly. NOTE that only a subset of these are
 * persisted by the API — see the persistence note at the top of `EnquiryForm`.
 */

import { INDIAN_STATES, SCHOOL_BOARDS, COURSES, CASTES, RELIGIONS } from '@/lib/utils';

const FIRST_NAMES_MALE = [
  'Aarav', 'Vihaan', 'Aditya', 'Sai', 'Arjun', 'Reyansh', 'Muhammad', 'Krishna', 'Ishaan', 'Shaurya',
  'Atharva', 'Ayaan', 'Dhruv', 'Kabir', 'Rohan', 'Rahul', 'Amit', 'Suresh', 'Ramesh', 'Vikram',
  'Siddharth', 'Nikhil', 'Pranav', 'Rishabh', 'Tanmay', 'Utkarsh', 'Varun', 'Yash', 'Zain', 'Ravi',
];

const FIRST_NAMES_FEMALE = [
  'Aadya', 'Diya', 'Saanvi', 'Ananya', 'Myra', 'Kiara', 'Pari', 'Fatima', 'Ayesha', 'Zara',
  'Riya', 'Priya', 'Sneha', 'Nisha', 'Pooja', 'Anjali', 'Kavita', 'Meera', 'Sita', 'Gita',
  'Lakshmi', 'Swati', 'Neha', 'Kriti', 'Isha', 'Jiya', 'Khushi', 'Lara', 'Mahi', 'Nia',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Malhotra', 'Singh', 'Kumar', 'Patel', 'Shah', 'Joshi', 'Mehta',
  'Agarwal', 'Jain', 'Saxena', 'Tiwari', 'Mishra', 'Tripathi', 'Dubey', 'Pandey', 'Yadav', 'Das',
  'Ghosh', 'Bose', 'Banerjee', 'Chatterjee', 'Mukherjee', 'Dutta', 'Sen', 'Nair', 'Menon', 'Pillai',
  'Reddy', 'Rao', 'Naidu', 'Chowdhury', 'Khan', 'Ahmed', 'Ali', 'Hussain', 'Hassan', 'Rahman',
];

const CITIES = [
  'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Ahmedabad', 'Chennai', 'Kolkata', 'Surat', 'Pune', 'Jaipur',
  'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Thane', 'Bhopal', 'Visakhapatnam', 'Patna', 'Vadodara',
  'Guwahati', 'Shillong', 'Imphal', 'Aizawl', 'Kohima', 'Gangtok', 'Agartala', 'Itanagar', 'Silchar',
];

const STREETS = [
  'MG Road', 'Station Road', 'Park Street', 'Main Road', 'Church Street', 'Temple Road', 'Market Road',
  'Hospital Road', 'School Road', 'College Road', 'Railway Road', 'Link Road', 'Ring Road', 'Bypass Road',
  'Sector 1', 'Sector 15', 'Phase 1', 'Block A', 'Civil Lines', 'Model Town', 'Shastri Nagar', 'Gandhi Nagar',
];

const SCHOOLS = [
  'Delhi Public School', 'Kendriya Vidyalaya', "St. Xavier's School", 'Don Bosco School', 'Army Public School',
  'Ryan International School', 'DAV Public School', 'Podar International School', 'Vibgyor High School',
  'The Heritage School', 'Sanskriti School', 'Modern School', 'Springdales School', 'Tagore International School',
  'Apeejay School', 'Bal Bharati Public School',
];

const PROFESSIONS = [
  'Engineer', 'Doctor', 'Teacher', 'Businessman', 'Lawyer', 'Accountant', 'Architect', 'Civil Servant',
  'Farmer', 'Shopkeeper', 'Driver', 'Nurse', 'Pharmacist', 'Technician', 'Artist', 'Writer', 'Journalist',
  'Police Officer', 'Soldier', 'Pilot', 'Chef', 'Mechanic', 'Electrician', 'Plumber',
];

const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'rediffmail.com'];

const HUBS = ['Bangalore', 'Chennai', 'Delhi', 'Hyderabad', 'Mumbai', 'Pune', 'Kota', 'Overseas'];

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 2): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

/** A plausible 10-digit Indian mobile number. */
function randomMobile(): string {
  let number = pick(['9', '8', '7', '6']);
  for (let i = 0; i < 9; i += 1) number += String(randomInt(0, 9));
  return number;
}

export interface RandomEnquiry {
  date: string;
  candidateName: string;
  mobile: string;
  email: string;
  gender: string;
  dob: string;
  caste: string;
  religion: string;
  fatherName: string;
  fatherOccupation: string;
  fatherMobile: string;
  motherName: string;
  motherOccupation: string;
  motherMobile: string;
  permanentAddress: string;
  familyPlace: string;
  familyState: string;
  courseInterested: string;
  gapYear: boolean;
  gapYearFrom?: number;
  gapYearTo?: number;
  collegeDropout: boolean;
  class10SchoolName: string;
  class10Board: string;
  class10PassingYear: string;
  class10Percentage: number;
  class10Place: string;
  class10State: string;
  schoolName: string;
  schoolBoard: string;
  stream: 'Science' | 'Commerce' | 'Arts';
  class12PassingYear: string;
  class12Percentage: number;
  schoolPlace: string;
  schoolState: string;
  physicsMarks?: number;
  chemistryMarks?: number;
  biologyMarks?: number;
  mathsMarks?: number;
  pcbPercentage?: number;
  pcmPercentage?: number;
  previousNeetMarks?: number;
  presentNeetMarks?: number;
  preferredLocations: string[];
  otherLocation?: string;
  paymentAmount: number;
}

export function generateRandomEnquiry(): RandomEnquiry {
  const gender = pick(['Male', 'Female', 'Other']);
  const firstNamePool =
    gender === 'Male'
      ? FIRST_NAMES_MALE
      : gender === 'Female'
        ? FIRST_NAMES_FEMALE
        : [...FIRST_NAMES_MALE, ...FIRST_NAMES_FEMALE];

  const firstName = pick(firstNamePool);
  const lastName = pick(LAST_NAMES);
  const today = new Date();

  const dobYear = today.getFullYear() - randomInt(16, 19);
  const dob = `${dobYear}-${String(randomInt(1, 12)).padStart(2, '0')}-${String(randomInt(1, 28)).padStart(2, '0')}`;

  const city = pick(CITIES);
  const stream = pick(['Science', 'Commerce', 'Arts'] as const);

  // Subject marks and NEET scores only make sense for the Science stream, and
  // the PCB/PCM averages must match what the form recomputes on change —
  // otherwise autofilling would immediately show two different numbers.
  const science = stream === 'Science';
  const physicsMarks = science ? randomInt(40, 99) : undefined;
  const chemistryMarks = science ? randomInt(40, 99) : undefined;
  const biologyMarks = science ? randomInt(40, 99) : undefined;
  const mathsMarks = science ? randomInt(40, 99) : undefined;

  const average = (...marks: number[]) =>
    parseFloat((marks.reduce((sum, mark) => sum + mark, 0) / marks.length).toFixed(2));

  const gapYear = Math.random() < 0.2;

  const preferredLocations = [...new Set(Array.from({ length: randomInt(1, 3) }, () => pick(HUBS)))];

  return {
    date: today.toISOString().split('T')[0],
    candidateName: `${firstName} ${lastName}`,
    mobile: randomMobile(),
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomInt(1, 999)}@${pick(EMAIL_DOMAINS)}`,
    gender,
    dob,
    caste: pick(CASTES),
    religion: pick(RELIGIONS),

    fatherName: `${pick(FIRST_NAMES_MALE)} ${lastName}`,
    fatherOccupation: pick(PROFESSIONS),
    fatherMobile: randomMobile(),

    motherName: `${pick(FIRST_NAMES_FEMALE)} ${lastName}`,
    motherOccupation: pick(PROFESSIONS),
    motherMobile: randomMobile(),

    permanentAddress: `${randomInt(1, 999)}, ${pick(STREETS)}, ${city}`,
    familyPlace: city,
    familyState: pick(INDIAN_STATES),

    courseInterested: pick(COURSES),
    gapYear,
    gapYearFrom: gapYear ? today.getFullYear() - 1 : undefined,
    gapYearTo: gapYear ? today.getFullYear() : undefined,
    collegeDropout: Math.random() < 0.1,

    class10SchoolName: pick(SCHOOLS),
    class10Board: pick(SCHOOL_BOARDS),
    class10PassingYear: String(today.getFullYear() - 2),
    class10Percentage: randomFloat(50, 98),
    class10Place: pick(CITIES),
    class10State: pick(INDIAN_STATES),

    schoolName: pick(SCHOOLS),
    schoolBoard: pick(SCHOOL_BOARDS),
    stream,
    class12PassingYear: String(today.getFullYear()),
    class12Percentage: randomFloat(50, 98),
    schoolPlace: pick(CITIES),
    schoolState: pick(INDIAN_STATES),

    physicsMarks,
    chemistryMarks,
    biologyMarks,
    mathsMarks,
    pcbPercentage:
      physicsMarks && chemistryMarks && biologyMarks
        ? average(physicsMarks, chemistryMarks, biologyMarks)
        : undefined,
    pcmPercentage:
      physicsMarks && chemistryMarks && mathsMarks
        ? average(physicsMarks, chemistryMarks, mathsMarks)
        : undefined,
    previousNeetMarks: science ? randomInt(100, 650) : undefined,
    presentNeetMarks: science ? randomInt(100, 700) : undefined,

    preferredLocations,
    otherLocation: Math.random() < 0.3 ? pick(CITIES) : undefined,
    paymentAmount: randomInt(5000, 500000),
  };
}
