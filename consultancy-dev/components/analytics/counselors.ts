'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

/**
 * Row shape returned by `GET users/counselors/` (UserViewSet.counselors).
 *
 * The endpoint returns a bare array, not a paginated envelope, and its figures
 * are already role-scoped server-side. `apiClient.dashboard.getCounselorAnalytics`
 * is typed `Promise<unknown>`, so the shape is asserted here in one place rather
 * than at each call site.
 */
export interface CounselorPerformance {
  id: number;
  name: string;
  email: string;
  avatar: string | null;
  branch: string | null;
  totalEnquiries: number;
  converted: number;
  registrations: number;
  enrollments: number;
  conversionRate: number;
}

function isCounselorRow(value: unknown): value is CounselorPerformance {
  return typeof value === 'object' && value !== null && 'id' in value && 'totalEnquiries' in value;
}

export function useCounselors(): UseQueryResult<CounselorPerformance[]> {
  return useQuery({
    queryKey: ['counselors'],
    queryFn: async (): Promise<CounselorPerformance[]> => {
      const data = await apiClient.dashboard.getCounselorAnalytics();
      return Array.isArray(data) ? data.filter(isCounselorRow) : [];
    },
    staleTime: 60_000,
  });
}
