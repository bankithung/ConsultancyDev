import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
  "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh",
  "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Lakshadweep", "Delhi", "Puducherry",
  "Ladakh", "Jammu and Kashmir"
];

export const SCHOOL_BOARDS = [
  // National Boards
  "CBSE (Central Board of Secondary Education)",
  "ICSE (Council for the Indian School Certificate Examinations)",
  "NIOS (National Institute of Open Schooling)",
  "IB (International Baccalaureate)",
  "CIE / IGCSE (Cambridge International Examinations)",

  // State Boards
  "AHSEC (Assam Higher Secondary Education Council)",
  "SEBA (Board of Secondary Education, Assam)",
  "NBSE (Nagaland Board of School Education)",
  "MBOSE (Meghalaya Board of School Education)",
  "MBSE (Mizoram Board of School Education)",
  "TBSE (Tripura Board of Secondary Education)",
  "COHSEM (Council of Higher Secondary Education, Manipur)",
  "BOSEM (Board of Secondary Education, Manipur)",
  "JKBOSE (Jammu and Kashmir State Board of School Education)",
  "MSBSHSE (Maharashtra State Board of Secondary and Higher Secondary Education)",
  "UPMSP (Uttar Pradesh Madhyamik Shiksha Parishad)",
  "WBBSE (West Bengal Board of Secondary Education)",
  "WBCHSE (West Bengal Council of Higher Secondary Education)",
  "BSEB (Bihar School Examination Board)",
  "GSEB (Gujarat Secondary and Higher Secondary Education Board)",
  "KSEEB (Karnataka Secondary Education Examination Board)",
  "TN BOARD (Tamil Nadu Board of Higher Secondary Education)",
  "BSEAP (Board of Secondary Education, Andhra Pradesh)",
  "TSBIE (Telangana State Board of Intermediate Education)",
  "MPBSE (Madhya Pradesh Board of Secondary Education)",
  "RBSE (Rajasthan Board of Secondary Education)",
  "PSEB (Punjab School Education Board)",
  "HBSE (Haryana Board of School Education)",
  "Other"
];

export const CLASS_12_STREAMS = ["Science", "Commerce", "Arts"];

export const COURSES = [
  // Medical Courses
  "MBBS (Bachelor of Medicine and Bachelor of Surgery)",
  "BDS (Bachelor of Dental Surgery)",
  "BAMS (Bachelor of Ayurvedic Medicine and Surgery)",
  "BHMS (Bachelor of Homeopathic Medicine and Surgery)",
  "BUMS (Bachelor of Unani Medicine and Surgery)",
  "BNYS (Bachelor of Naturopathy and Yogic Sciences)",
  "BPT (Bachelor of Physiotherapy)",
  "B.Pharm (Bachelor of Pharmacy)",
  "D.Pharm (Diploma in Pharmacy)",
  "BMLT (Bachelor in Medical Lab Technology)",
  "B.Sc Nursing",
  "GNM (General Nursing and Midwifery)",
  "ANM (Auxiliary Nursing and Midwifery)",

  // Engineering Courses
  "B.Tech / B.E (Bachelor of Technology/Engineering)",
  "B.Arch (Bachelor of Architecture)",
  "BCA (Bachelor of Computer Applications)",
  "B.Sc (Computer Science)",
  "B.Sc (IT)",

  // Science Courses
  "B.Sc (Physics)",
  "B.Sc (Chemistry)",
  "B.Sc (Mathematics)",
  "B.Sc (Biology)",
  "B.Sc (Biotechnology)",
  "B.Sc (Microbiology)",
  "B.Sc (Agriculture)",

  // Commerce Courses
  "B.Com (Bachelor of Commerce)",
  "BBA (Bachelor of Business Administration)",
  "CA (Chartered Accountancy)",
  "CS (Company Secretary)",
  "CMA (Cost and Management Accountant)",

  // Arts/Humanities Courses
  "BA (Bachelor of Arts)",
  "B.Ed (Bachelor of Education)",
  "BFA (Bachelor of Fine Arts)",
  "BJMc (Bachelor of Journalism and Mass Communication)",
  "LLB (Bachelor of Laws)",
  "BA LLB (Integrated Law)",

  // Other
  "Other"
];

export const PREFERRED_LOCATIONS = [
  "Bangalore",
  "Chennai",
  "Delhi",
  "Hyderabad",
  "Kota",
  "Kolkata",
  "Mumbai",
  "Pune",
  "Ahmedabad",
  "Jaipur",
  "Lucknow",
  "Chandigarh",
  "Bhopal",
  "Indore",
  "Nagpur",
  "Coimbatore",
  "Thiruvananthapuram",
  "Guwahati",
  "Patna",
  "Varanasi",
  "Overseas",
  "Other"
];

export const GENDERS = ["Male", "Female", "Other"];

export const CASTES = [
  "General",
  "OBC",
  "MOBC",
  "SC",
  "ST",
  "EWS",
  "Other"
];

export const RELIGIONS = [
  "Hindu",
  "Muslim",
  "Christian",
  "Sikh",
  "Buddhist",
  "Jain",
  "Other"
];

// Avatar color generator - returns consistent color based on name
const AVATAR_COLORS = [
  { bg: 'bg-blue-100', text: 'text-blue-600' },
  { bg: 'bg-purple-100', text: 'text-purple-600' },
  { bg: 'bg-green-100', text: 'text-green-600' },
  { bg: 'bg-amber-100', text: 'text-amber-600' },
  { bg: 'bg-rose-100', text: 'text-rose-600' },
  { bg: 'bg-teal-100', text: 'text-teal-600' },
  { bg: 'bg-indigo-100', text: 'text-indigo-600' },
  { bg: 'bg-pink-100', text: 'text-pink-600' },
  { bg: 'bg-cyan-100', text: 'text-cyan-600' },
  { bg: 'bg-orange-100', text: 'text-orange-600' },
];

export function getAvatarColor(name: string): { bg: string; text: string } {
  if (!name) return AVATAR_COLORS[0];
  const charCode = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return AVATAR_COLORS[charCode % AVATAR_COLORS.length];
}

export function getInitials(name: string, count: number = 1): string {
  if (!name) return '?';
  const parts = name.trim().split(' ').filter(Boolean);
  if (count === 1) return parts[0]?.charAt(0).toUpperCase() || '?';
  return parts.slice(0, count).map(p => p.charAt(0).toUpperCase()).join('');
}
