'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, fetchAllPages } from '@/lib/apiClient';
import { useAuthStore } from '@/store/authStore';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BackButton } from '@/components/ui/back-button';
import { ErrorState } from '@/components/common/states';
import { ROLE_LABELS } from '@/components/rbac/roles';
import { toast } from '@/store/toastStore';
import {
  User as UserIcon,
  Mail,
  Phone,
  MapPin,
  Briefcase,
  Activity as ActivityIcon,
  Calendar,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { Enquiry, FollowUp, Registration, Task } from '@/lib/types';

/**
 * Staff profile.
 *
 * The old build called `http://127.0.0.1:8000/api/users/{id}/stats|activity-logs|
 * earnings|entries|toggle-status/` directly with a token pulled out of
 * localStorage. None of those routes exist on this backend, and the hardcoded
 * host meant they could only ever work on one developer's machine. Every panel
 * below is rebuilt on endpoints this API actually serves:
 *
 *   profile        users/{id}/
 *   enable/disable users/{id}/set-active/   (flips is_active_employee)
 *   performance    users/counselors/        (server-computed, bare array)
 *   entries        enquiries/ + registrations/ filtered by `owner`
 *   follow-ups     follow-ups/  (walked, then matched on assigned_to)
 *   tasks          tasks/       (walked, then matched on assigned_to)
 *   activity       derived from the records above — see ActivityFeed
 *
 * GAP: there is no per-user earnings endpoint. Commissions are keyed by
 * `agent_name`, not by user id, so a per-employee total cannot be computed
 * without guessing. The tab explains that instead of showing a fabricated ₹0.
 */

const SidebarDetail = ({
  icon: Icon,
  value,
  label,
}: {
  icon: LucideIcon;
  value: string | null | undefined;
  label?: string;
}) => {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon size={16} className="text-slate-400 mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col">
        <span className="text-slate-700 font-medium leading-tight break-all">{value}</span>
        {label && <span className="text-[10px] text-slate-400 uppercase tracking-wide">{label}</span>}
      </div>
    </div>
  );
};

const DetailRow = ({
  label,
  value,
  icon: Icon,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
}) => (
  <div className={`flex flex-col min-w-0 ${className}`}>
    <div className="flex items-center text-[10px] font-bold text-slate-400 uppercase tracking-widest gap-1.5 mb-0.5 shrink-0">
      {Icon && <Icon size={10} className="text-slate-400 shrink-0" />}
      <span className="truncate">{label}</span>
    </div>
    <div
      className="text-sm font-medium text-slate-800 leading-snug break-words"
      title={typeof value === 'string' ? value : ''}
    >
      {value || <span className="text-slate-300 italic text-xs">N/A</span>}
    </div>
  </div>
);

const SectionHeader = ({ title, icon: Icon }: { title: string; icon?: LucideIcon }) => (
  <div className="flex items-center gap-2">
    {Icon && <Icon size={14} className="text-slate-500" />}
    <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest">{title}</h3>
  </div>
);

/** One row of the derived activity feed. */
interface ActivityEntry {
  id: string;
  kind: 'enquiry' | 'registration' | 'follow-up';
  description: string;
  timestamp: number;
  when: string;
}

const KIND_DOT: Record<ActivityEntry['kind'], string> = {
  enquiry: 'bg-blue-500',
  registration: 'bg-green-500',
  'follow-up': 'bg-yellow-500',
};

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export default function EmployeeProfilePage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuthStore();
  const id = params.id as string;
  const [activeTab, setActiveTab] = useState('overview');
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const {
    data: employee,
    isLoading: loadingEmployee,
    isError: employeeError,
    error: employeeErrorObject,
    refetch: refetchEmployee,
  } = useQuery({
    queryKey: ['user', id],
    // A dedicated detail route — the old code pulled the whole user list and
    // ran `.find`, which silently misses anyone past the first page.
    queryFn: () => apiClient.users.get(id),
    enabled: id !== '',
  });

  /** Server-computed performance, scoped and grouped backend-side. */
  const { data: performance } = useQuery({
    queryKey: ['counselor-analytics'],
    queryFn: () => apiClient.dashboard.getCounselorAnalytics(),
    enabled: id !== '',
  });

  const { data: entries } = useQuery({
    queryKey: ['user', id, 'entries'],
    queryFn: async () => {
      // `owner` IS in the filterset for both endpoints, so this filters
      // server-side rather than pulling everything down to sift it.
      const [enquiries, registrations] = await Promise.all([
        apiClient.enquiries.list({ filters: { owner: id }, ordering: '-created_at', page_size: 50 }),
        apiClient.registrations.list({ filters: { owner: id }, ordering: '-created_at', page_size: 50 }),
      ]);
      return { enquiries: enquiries.results, registrations: registrations.results };
    },
    enabled: id !== '',
  });

  const { data: followUps = [] } = useQuery({
    queryKey: ['user', id, 'followups'],
    queryFn: async () => {
      // `follow-ups/` declares no `assigned_to` filter, and an unlisted filter
      // is IGNORED server-side (you get unfiltered rows back), so the match has
      // to happen here — over every page, not just the first.
      const all = await fetchAllPages<FollowUp, FollowUp>('follow-ups/', (f) => f, { ordering: '-scheduled_for' }, 200, 10);
      return all.filter((f) => f.assigned_to !== null && String(f.assigned_to) === id);
    },
    enabled: id !== '',
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ['user', id, 'tasks'],
    queryFn: async () => {
      const all = await fetchAllPages<Task, Task>('tasks/', (t) => t, { ordering: '-due_date' }, 200, 10);
      // `Task.assignedTo` is a free string on the wire — it may hold the id,
      // the username or the display name, so all three are accepted.
      const candidates = new Set(
        [id, employee?.username, employee?.full_name].filter((v): v is string => typeof v === 'string' && v !== '')
      );
      return all.filter((t) => candidates.has(t.assignedTo));
    },
    enabled: id !== '' && employee !== undefined,
  });

  const performanceRow = useMemo(
    () => performance?.find((row) => String(row.id) === id),
    [performance, id]
  );

  const stats = useMemo(() => {
    const completedFollowups = followUps.filter((f) => f.status === 'Completed').length;
    const completedTasks = tasks.filter((t) => t.status === 'Done').length;
    return {
      totalEnquiries: performanceRow?.totalEnquiries ?? 0,
      totalRegistrations: performanceRow?.registrations ?? 0,
      enrollments: performanceRow?.enrollments ?? 0,
      converted: performanceRow?.converted ?? 0,
      conversionRate: performanceRow?.conversionRate ?? 0,
      activeFollowups: followUps.length - completedFollowups,
      completedFollowups,
      activeTasks: tasks.length - completedTasks,
      completedTasks,
    };
  }, [performanceRow, followUps, tasks]);

  const activity = useMemo<ActivityEntry[]>(() => {
    const rows: ActivityEntry[] = [
      ...(entries?.enquiries ?? []).map((e: Enquiry) => ({
        id: `enq-${e.id}`,
        kind: 'enquiry' as const,
        description: `Logged enquiry from ${e.candidateName}`,
        timestamp: parseTime(e.date),
        when: e.date,
      })),
      ...(entries?.registrations ?? []).map((r: Registration) => ({
        id: `reg-${r.id}`,
        kind: 'registration' as const,
        description: `Registered ${r.studentName} (${r.registrationNo})`,
        timestamp: parseTime(r.registrationDate),
        when: r.registrationDate,
      })),
      ...followUps.map((f) => ({
        id: `fup-${f.id}`,
        kind: 'follow-up' as const,
        description: `${f.type} follow-up with ${f.enquiry_candidate} — ${f.status}`,
        timestamp: parseTime(f.scheduled_for),
        when: f.scheduled_for,
      })),
    ];
    return rows.filter((row) => row.timestamp > 0).sort((a, b) => b.timestamp - a.timestamp);
  }, [entries, followUps]);

  if (loadingEmployee) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600" />
      </div>
    );
  }

  if (employeeError) {
    return (
      <div className="p-4">
        <ErrorState error={employeeErrorObject} onRetry={() => void refetchEmployee()} title="Could not load this employee" />
      </div>
    );
  }

  if (!employee) {
    return <div className="p-8 text-center text-slate-500">Employee not found</div>;
  }

  const employeeName = employee.full_name || employee.username;
  // `is_active_employee` gates login; Django's `is_active` is a separate flag
  // and is NOT what "suspended" means here.
  const isEnabled = employee.is_active_employee;

  const confirmToggleStatus = async () => {
    setTogglingStatus(true);
    setIsConfirmOpen(false);
    try {
      await apiClient.users.setActive(employee.id, !isEnabled);
      await queryClient.invalidateQueries({ queryKey: ['user', id] });
      await queryClient.invalidateQueries({ queryKey: ['team-members'] });
      toast.success(isEnabled ? 'Account suspended' : 'Account activated');
    } catch {
      // The backend refuses self-deactivation with a 400; the control below is
      // already hidden for your own row, so anything here is a real failure.
      toast.error('Could not update the account', 'Please try again.');
    } finally {
      setTogglingStatus(false);
    }
  };

  const canManageAccounts =
    (currentUser?.role === 'COMPANY_ADMIN' || currentUser?.role === 'DEV_ADMIN') &&
    String(currentUser?.id) !== id;

  return (
    <div className="max-w-[1600px] mx-auto px-4 py-1 lg:px-6 lg:py-2 bg-slate-50/30 min-h-screen">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-2">
        <BackButton />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
        {/* SIDEBAR */}
        <div className="lg:col-span-4 xl:col-span-3 space-y-4">
          <Card className="border border-slate-200 shadow-sm overflow-hidden">
            <CardHeader className="bg-gradient-to-br from-slate-900 to-slate-800 p-6 flex flex-col items-center text-center">
              <div className="h-20 w-20 rounded-full bg-white/10 flex items-center justify-center text-white text-3xl font-bold shadow-inner mb-4 ring-2 ring-white/20">
                {employeeName.charAt(0).toUpperCase()}
              </div>
              <h1 className="text-xl font-bold text-white leading-tight break-words">{employeeName}</h1>
              <span className="mt-2 px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border bg-teal-500/20 text-teal-100 border-teal-500/30">
                {ROLE_LABELS[employee.role]}
              </span>
            </CardHeader>
            <CardContent className="p-5 space-y-6">
              <div className="space-y-4 pt-4 border-t border-slate-100">
                <SidebarDetail icon={Phone} value={employee.phone} label="Mobile" />
                <SidebarDetail icon={Mail} value={employee.email} label="Email" />
                <SidebarDetail icon={MapPin} value={employee.branch_name} label="Branch" />
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="py-3 px-4 bg-slate-50/50 border-b border-slate-100">
              <SectionHeader title="Performance Highlights" icon={TrendingUp} />
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-3">
                <div className="flex justify-between items-center gap-2">
                  <span className="text-xs text-slate-600">Total Enquiries</span>
                  <span className="text-sm font-bold text-teal-600">{stats.totalEnquiries}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-xs text-slate-600">Registrations</span>
                  <span className="text-sm font-bold text-green-600">{stats.totalRegistrations}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-xs text-slate-600">Conversion Rate</span>
                  <span className="text-sm font-bold text-purple-600">{stats.conversionRate}%</span>
                </div>
                <div className="border-t border-slate-100 pt-3 mt-3">
                  <div className="flex justify-between items-center gap-2 mb-2">
                    <span className="text-xs text-slate-600">Active Tasks</span>
                    <span className="text-sm font-bold text-orange-600">{stats.activeTasks}</span>
                  </div>
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-xs text-slate-600">Active Follow-ups</span>
                    <span className="text-sm font-bold text-yellow-600">{stats.activeFollowups}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 shadow-sm">
            <CardHeader className="py-3 px-4 bg-slate-50/50 border-b border-slate-100">
              <SectionHeader title="Recent Activity" icon={ActivityIcon} />
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-3">
                {activity.slice(0, 5).map((log) => (
                  <div key={log.id} className="flex gap-2 items-start">
                    <div className="mt-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${KIND_DOT[log.kind]}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-900 font-medium truncate">{log.description}</p>
                      <p className="text-[10px] text-slate-500">{format(new Date(log.when), 'MMM dd, HH:mm')}</p>
                    </div>
                  </div>
                ))}
                {activity.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No recent activity</p>}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* MAIN CONTENT */}
        <div className="lg:col-span-8 xl:col-span-9 space-y-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <div className="bg-white border border-slate-200 rounded-lg mb-4 shadow-sm overflow-x-auto">
              <TabsList className="h-10 bg-white w-max min-w-full justify-start gap-2 sm:gap-6 px-2">
                {['Overview', 'Entries', 'Follow-ups', 'Tasks', 'Earnings', 'Activity'].map((tab) => (
                  <TabsTrigger
                    key={tab.toLowerCase().replace('-', '')}
                    value={tab.toLowerCase().replace('-', '')}
                    className="h-10 rounded-none border-b-2 border-transparent px-2 sm:px-3 text-[10px] sm:text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-800 data-[state=active]:border-teal-600 data-[state=active]:text-teal-600 data-[state=active]:shadow-none transition-all whitespace-nowrap"
                  >
                    {tab}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* Overview */}
            <TabsContent value="overview" className="space-y-4 focus-visible:outline-none mt-0">
              <div className="bg-white border border-slate-200 rounded-lg p-3 sm:p-4 shadow-sm">
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Enquiries</p>
                    <p className="text-2xl font-bold text-teal-600">{stats.totalEnquiries}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Registrations</p>
                    <p className="text-2xl font-bold text-green-600">{stats.totalRegistrations}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Enrollments</p>
                    <p className="text-2xl font-bold text-purple-600">{stats.enrollments}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Active F-ups</p>
                    <p className="text-2xl font-bold text-yellow-600">{stats.activeFollowups}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Done F-ups</p>
                    <p className="text-2xl font-bold text-teal-600">{stats.completedFollowups}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Active Tasks</p>
                    <p className="text-2xl font-bold text-orange-600">{stats.activeTasks}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-slate-500 mb-1">Done Tasks</p>
                    <p className="text-2xl font-bold text-emerald-600">{stats.completedTasks}</p>
                  </div>
                </div>
              </div>

              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 bg-slate-50/50 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <UserIcon size={14} className="text-slate-500" />
                    <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest">Employee Details</h3>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {/* Account. The old build showed gender / dob / religion /
                      parents_name / state_from — none of those columns exist on
                      this backend's user model. */}
                  <div className="p-5 border-b border-slate-100">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="h-1.5 w-1.5 rounded-full bg-teal-500" />
                      <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider">Account</h4>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
                      <DetailRow label="Full Name" value={employeeName} />
                      <DetailRow label="First Name" value={employee.first_name} />
                      <DetailRow label="Last Name" value={employee.last_name} />
                      <DetailRow label="Username" value={`@${employee.username}`} />
                      <DetailRow label="Email" value={employee.email} icon={Mail} />
                      <DetailRow label="Phone" value={employee.phone} icon={Phone} />
                      <DetailRow
                        label="Last Login"
                        value={employee.last_login ? format(new Date(employee.last_login), 'dd MMM yyyy, HH:mm') : null}
                        icon={Calendar}
                      />
                      <DetailRow label="Employee ID" value={`#${employee.id}`} />
                    </div>
                  </div>

                  <div className="p-5 border-b border-slate-100">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider">Employment</h4>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
                      <DetailRow label="System Role" value={ROLE_LABELS[employee.role]} icon={Briefcase} />
                      <DetailRow label="Role (server label)" value={employee.role_display} />
                      <DetailRow label="Company" value={employee.company_name} />
                      <DetailRow
                        label="Account Status"
                        value={
                          <span
                            className={`px-2.5 py-1 rounded text-xs font-bold uppercase ${
                              isEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {isEnabled ? '✓ Active' : '✗ Suspended'}
                          </span>
                        }
                      />
                    </div>
                  </div>

                  <div className="p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="h-1.5 w-1.5 rounded-full bg-purple-500" />
                      <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider">Assignment</h4>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
                      {/* Branch replaced assigned_state / assigned_district /
                          assigned_location — staff are scoped by branch now. */}
                      <DetailRow label="Branch" value={employee.branch_name} icon={MapPin} />
                      <DetailRow label="Branch ID" value={employee.branch === null ? null : `#${employee.branch}`} />
                      <DetailRow label="Company ID" value={employee.company === null ? null : `#${employee.company}`} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {canManageAccounts && (
                <Card className="border border-slate-200 shadow-sm">
                  <CardContent className="p-4">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-700">Account Management</h4>
                        <p className="text-xs text-slate-500">Enable or suspend this employee&apos;s access</p>
                      </div>
                      <Button
                        variant={isEnabled ? 'destructive' : 'default'}
                        onClick={() => setIsConfirmOpen(true)}
                        disabled={togglingStatus}
                        size="sm"
                      >
                        {togglingStatus ? 'Updating...' : isEnabled ? 'Suspend Account' : 'Activate Account'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Entries */}
            <TabsContent value="entries" className="space-y-4 focus-visible:outline-none mt-0">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">Enquiries Created ({entries?.enquiries.length ?? 0})</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="space-y-2">
                    {(entries?.enquiries ?? []).slice(0, 10).map((enq) => (
                      <div
                        key={enq.id}
                        className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm text-slate-900 truncate">{enq.candidateName}</p>
                          <p className="text-xs text-slate-600 truncate">{enq.courseInterested}</p>
                        </div>
                        <div className="sm:text-right shrink-0">
                          <p className="text-xs text-slate-500 mb-1">{format(new Date(enq.date), 'dd MMM yyyy')}</p>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              enq.status === 'Converted'
                                ? 'bg-green-100 text-green-700'
                                : enq.status === 'New'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {enq.status}
                          </span>
                        </div>
                      </div>
                    ))}
                    {(entries?.enquiries.length ?? 0) === 0 && (
                      <div className="text-center py-8 text-xs text-slate-400">No enquiries found</div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">
                    Registrations Created ({entries?.registrations.length ?? 0})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="space-y-2">
                    {(entries?.registrations ?? []).slice(0, 10).map((reg) => (
                      <div
                        key={reg.id}
                        className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm text-slate-900 truncate">{reg.studentName}</p>
                          <p className="text-xs text-slate-600 truncate">{reg.registrationNo}</p>
                        </div>
                        <p className="text-xs text-slate-500 shrink-0">
                          {format(new Date(reg.registrationDate), 'dd MMM yyyy')}
                        </p>
                      </div>
                    ))}
                    {(entries?.registrations.length ?? 0) === 0 && (
                      <div className="text-center py-8 text-xs text-slate-400">No registrations found</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Follow-ups */}
            <TabsContent value="followups" className="space-y-4 focus-visible:outline-none mt-0">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">Follow-ups ({followUps.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="space-y-2">
                    {followUps.map((f) => (
                      <div
                        key={f.id}
                        className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm text-slate-900 truncate">{f.enquiry_candidate}</p>
                          <p className="text-xs text-slate-600 truncate">
                            {f.type}
                            {f.notes ? ` — ${f.notes}` : ''}
                          </p>
                        </div>
                        <div className="sm:text-right shrink-0">
                          <p className="text-xs text-slate-500 mb-1">{format(new Date(f.scheduled_for), 'dd MMM HH:mm')}</p>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              f.status === 'Completed'
                                ? 'bg-green-100 text-green-700'
                                : f.status === 'Pending'
                                  ? 'bg-yellow-100 text-yellow-700'
                                  : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {f.status}
                          </span>
                        </div>
                      </div>
                    ))}
                    {followUps.length === 0 && (
                      <div className="text-center py-8 text-xs text-slate-400">No follow-ups assigned</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Tasks */}
            <TabsContent value="tasks" className="space-y-4 focus-visible:outline-none mt-0">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">Tasks ({tasks.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="space-y-2">
                    {tasks.map((t) => (
                      <div
                        key={t.id}
                        className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm text-slate-900 truncate">{t.title}</p>
                          <p className="text-xs text-slate-600">Due: {t.dueDate}</p>
                        </div>
                        <span
                          className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            t.status === 'Done'
                              ? 'bg-green-100 text-green-700'
                              : t.status === 'In Progress'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {t.status}
                        </span>
                      </div>
                    ))}
                    {tasks.length === 0 && <div className="text-center py-8 text-xs text-slate-400">No tasks assigned</div>}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Earnings */}
            <TabsContent value="earnings" className="space-y-4 focus-visible:outline-none mt-0">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">Earnings History</CardTitle>
                </CardHeader>
                <CardContent className="p-6 text-center">
                  {/* Deliberately not a ₹0 total: commissions are keyed by
                      `agent_name`, so no endpoint can attribute money to this
                      user id. A fabricated zero would read as "earned nothing". */}
                  <p className="text-sm font-semibold text-slate-900">Per-employee earnings are not tracked</p>
                  <p className="mx-auto mt-2 max-w-md text-xs text-slate-500">
                    Commissions are recorded against an agent name rather than a staff account, so they cannot be
                    attributed to this profile. Company-wide figures are on the Earnings page.
                  </p>
                  <Button variant="outline" size="sm" className="mt-4" asChild>
                    <a href="/app/earnings">Open Earnings</a>
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Activity */}
            <TabsContent value="activity" className="space-y-4 focus-visible:outline-none mt-0">
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="py-3 px-4 border-b border-slate-100">
                  <CardTitle className="text-sm font-bold">Activity Log</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  {/* Derived from this user's own records — the API has no
                      login/logout audit trail to read. */}
                  <div className="space-y-2">
                    {activity.map((log) => (
                      <div key={log.id} className="flex gap-3 items-start p-3 bg-slate-50 rounded-lg border border-slate-100">
                        <div className="mt-1.5">
                          <div className={`w-2 h-2 rounded-full ${KIND_DOT[log.kind]}`} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm text-slate-900 break-words">{log.description}</p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {format(new Date(log.when), 'dd MMM yyyy HH:mm')}
                          </p>
                        </div>
                      </div>
                    ))}
                    {activity.length === 0 && (
                      <div className="text-center py-8 text-xs text-slate-400">No activity found</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <ConfirmDialog
        open={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={() => void confirmToggleStatus()}
        title={isEnabled ? 'Suspend Account?' : 'Activate Account?'}
        description={
          isEnabled
            ? `Are you sure you want to suspend ${employeeName}'s account? They will lose all access to the system immediately.`
            : `Are you sure you want to activate ${employeeName}'s account? Their access will be restored.`
        }
        confirmText={isEnabled ? 'Suspend Account' : 'Activate Account'}
        confirmVariant={isEnabled ? 'destructive' : 'default'}
        isLoading={togglingStatus}
      />
    </div>
  );
}
