'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Users,
  TrendingUp,
  Trophy,
  ChevronRight,
  Search,
  Mail,
  Phone,
  MapPin,
  UserPlus,
  Briefcase,
  Calendar,
  Activity,
  Filter,
  LayoutGrid,
  List,
  Star,
  Clock,
  Loader2
} from 'lucide-react';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { fetchAllPages } from '@/lib/apiClient';
import { ErrorState } from '@/components/common/states';
import { ALL_ROLES, ROLE_LABELS } from '@/components/rbac/roles';
import type { Role, User } from '@/lib/types';

/**
 * Team directory.
 *
 * The backend scopes `users/` to the caller's company already, so there is no
 * client-side company filter — the old `company_id` comparison is gone with the
 * field. Stats cover the WHOLE team, so this walks every page rather than
 * counting one page of 25.
 */

const ROLE_COLORS: Record<Role, { bg: string; text: string; border: string }> = {
  DEV_ADMIN: { bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-200' },
  COMPANY_ADMIN: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
  HEAD_MANAGER: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
  BRANCH_MANAGER: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  EMPLOYEE: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
};

const FALLBACK_ROLE_STYLE = ROLE_COLORS.EMPLOYEE;

function roleStyleOf(role: Role): { bg: string; text: string; border: string } {
  return ROLE_COLORS[role] ?? FALLBACK_ROLE_STYLE;
}

export default function CounselorsPage() {
  const { user } = useAuthStore();
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const {
    data: teamMembers = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['team-members'],
    queryFn: () => fetchAllPages<User, User>('users/', (u) => u, { ordering: 'first_name' }, 200, 10),
  });

  const stats = useMemo(() => {
    // `is_active_employee` is the flag that gates login; Django's `is_active`
    // is a different thing and is not what "Active staff" means here.
    const active = teamMembers.filter((m) => m.is_active_employee).length;
    const total = teamMembers.length;
    const roles = new Set(teamMembers.map((m) => m.role));
    return {
      total,
      active,
      inactive: total - active,
      activityRate: total > 0 ? Math.round((active / total) * 100) : 0,
      uniqueRoles: roles.size,
    };
  }, [teamMembers]);

  const filteredMembers = useMemo(() => {
    const needle = searchTerm.toLowerCase();
    return teamMembers.filter((member) => {
      const fullName = `${member.first_name} ${member.last_name}`.toLowerCase();
      const matchesSearch =
        needle === '' ||
        fullName.includes(needle) ||
        member.full_name.toLowerCase().includes(needle) ||
        member.email.toLowerCase().includes(needle) ||
        member.username.toLowerCase().includes(needle) ||
        (member.phone ?? '').includes(searchTerm);

      const matchesRole = roleFilter === 'all' || member.role === roleFilter;
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && member.is_active_employee) ||
        (statusFilter === 'inactive' && !member.is_active_employee);

      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [teamMembers, searchTerm, roleFilter, statusFilter]);

  const isAdmin = user?.role === 'COMPANY_ADMIN' || user?.role === 'DEV_ADMIN';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
          <span className="text-sm text-slate-500">Loading team data...</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return <ErrorState error={error} onRetry={() => void refetch()} title="Could not load the team" />;
  }

  return (
    <div className="space-y-4">
      {/* Stats Row - Compact with colored borders */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-all">
          <div className="h-1 w-full bg-slate-400" />
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Total Team</p>
                <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
              </div>
              <div className="p-2.5 bg-slate-100 rounded-lg">
                <Users size={18} className="text-slate-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-all">
          <div className="h-1 w-full bg-emerald-500" />
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">Active</p>
                <p className="text-2xl font-bold text-emerald-600">{stats.active}</p>
              </div>
              <div className="p-2.5 bg-emerald-50 rounded-lg">
                <TrendingUp size={18} className="text-emerald-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-all">
          <div className="h-1 w-full bg-amber-500" />
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">Inactive</p>
                <p className="text-2xl font-bold text-amber-600">{stats.inactive}</p>
              </div>
              <div className="p-2.5 bg-amber-50 rounded-lg">
                <Clock size={18} className="text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-all">
          <div className="h-1 w-full bg-blue-500" />
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">Activity Rate</p>
                <p className="text-2xl font-bold text-blue-600">{stats.activityRate}%</p>
              </div>
              <div className="p-2.5 bg-blue-50 rounded-lg">
                <Activity size={18} className="text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 col-span-2 lg:col-span-1 overflow-hidden shadow-sm hover:shadow-md transition-all">
          <div className="h-1 w-full bg-purple-500" />
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Departments</p>
                <p className="text-2xl font-bold text-purple-600">{stats.uniqueRoles}</p>
              </div>
              <div className="p-2.5 bg-purple-50 rounded-lg">
                <Briefcase size={18} className="text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search, Filters & Add Button - All in one row */}
      <div className="flex flex-wrap items-center gap-2 bg-white p-3 rounded-lg shadow-sm">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-[400px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search by name, email, or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-9 text-xs border-0 bg-slate-50 focus:bg-white focus:ring-1 focus:ring-teal-500"
          />
        </div>

        {/* Role Filter */}
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="h-9 w-[120px] text-xs border-0 bg-slate-50">
            <SelectValue placeholder="All Roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {ALL_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {ROLE_LABELS[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Status Filter */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-[110px] text-xs border-0 bg-slate-50">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        {/* View Toggle */}
        <div className="flex bg-slate-100 p-1 rounded-lg">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              "p-1.5 rounded transition-colors",
              viewMode === 'grid' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
            )}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={cn(
              "p-1.5 rounded transition-colors",
              viewMode === 'list' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
            )}
          >
            <List size={16} />
          </button>
        </div>

        {(searchTerm || roleFilter !== 'all' || statusFilter !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchTerm('');
              setRoleFilter('all');
              setStatusFilter('all');
            }}
            className="h-9 text-xs text-slate-500 hover:text-slate-700"
          >
            Clear
          </Button>
        )}

        <div className="flex-1" />

        {/* Add Team Member Button */}
        {isAdmin && (
          <Button size="sm" className="bg-teal-600 hover:bg-teal-700 h-9 text-xs shrink-0" asChild>
            <Link href="/app/users">
              <UserPlus size={14} className="mr-1.5" /> Add Team Member
            </Link>
          </Button>
        )}
      </div>

      {/* Team Members Display */}
      {filteredMembers.length === 0 ? (
        <Card className="border-slate-200 border-dashed">
          <CardContent className="py-12 text-center">
            <Users size={40} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm text-slate-500">
              {searchTerm || roleFilter !== 'all' || statusFilter !== 'all'
                ? 'No team members found matching your filters.'
                : 'No team members found.'}
            </p>
          </CardContent>
        </Card>
      ) : viewMode === 'grid' ? (
        /* Grid View */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filteredMembers.map((member) => {
            const fullName = member.full_name || member.username;
            const initial = fullName.charAt(0).toUpperCase();
            const roleStyle = roleStyleOf(member.role);

            return (
              <Card
                key={member.id}
                className="border-slate-200 hover:border-teal-200 hover:shadow-md transition-all group overflow-hidden"
              >
                <CardContent className="p-0">
                  {/* Top banner */}
                  <div className={cn("h-1.5", roleStyle.bg)} />

                  <div className="p-4">
                    {/* Avatar and Name */}
                    <div className="flex items-start gap-3 mb-3">
                      <div className="relative">
                        {member.avatar ? (
                          <img
                            src={member.avatar}
                            alt={fullName}
                            className="w-11 h-11 rounded-full object-cover border-2 border-white shadow-sm"
                          />
                        ) : (
                          <div className={cn("w-11 h-11 rounded-full flex items-center justify-center border-2 border-white shadow-sm", roleStyle.bg)}>
                            <span className={cn("text-base font-bold", roleStyle.text)}>{initial}</span>
                          </div>
                        )}
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white",
                            member.is_active_employee ? 'bg-emerald-500' : 'bg-slate-300'
                          )}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate text-sm">{fullName}</h3>
                        <span className={cn(
                          "inline-block mt-0.5 px-2 py-0.5 rounded text-[9px] font-bold uppercase",
                          roleStyle.bg, roleStyle.text, roleStyle.border, "border"
                        )}>
                          {ROLE_LABELS[member.role]}
                        </span>
                      </div>
                    </div>

                    {/* Contact Info - Compact */}
                    <div className="space-y-1.5 mb-3">
                      <div className="flex items-center gap-2 text-xs text-slate-600">
                        <Mail size={11} className="text-slate-400 shrink-0" />
                        <span className="truncate">{member.email || '-'}</span>
                      </div>
                      {member.phone && (
                        <div className="flex items-center gap-2 text-xs text-slate-600">
                          <Phone size={11} className="text-slate-400 shrink-0" />
                          <span>{member.phone}</span>
                        </div>
                      )}
                      {/* Location is the assigned BRANCH now — there are no
                          assigned_state/assigned_district columns any more. */}
                      {member.branch_name && (
                        <div className="flex items-center gap-2 text-xs text-slate-600">
                          <MapPin size={11} className="text-slate-400 shrink-0" />
                          <span className="truncate">{member.branch_name}</span>
                        </div>
                      )}
                      {/* The API exposes no joining date; `last_login` is the
                          closest signal of when this account was last used. */}
                      {member.last_login && (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <Calendar size={11} className="text-slate-400 shrink-0" />
                          <span>Last active {format(new Date(member.last_login), 'dd MMM yyyy')}</span>
                        </div>
                      )}
                    </div>

                    {/* View Profile Button */}
                    <Link href={`/app/counselors/${member.id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-8 text-xs border-slate-200 hover:bg-teal-50 hover:text-teal-700 hover:border-teal-200 group-hover:border-teal-300"
                      >
                        View Profile
                        <ChevronRight className="ml-1 h-3 w-3" />
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        /* List View */
        <Card className="border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase">Team Member</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase">Role</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase hidden md:table-cell">Contact</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase hidden lg:table-cell">Branch</th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-600 uppercase">Status</th>
                  <th className="px-3 py-2.5 text-center text-[11px] font-semibold text-slate-600 uppercase">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((member, index) => {
                  const fullName = member.full_name || member.username;
                  const initial = fullName.charAt(0).toUpperCase();
                  const roleStyle = roleStyleOf(member.role);

                  return (
                    <tr
                      key={member.id}
                      className={cn(
                        "border-b border-slate-100 hover:bg-slate-50 transition-colors",
                        index % 2 === 0 ? 'bg-white' : 'bg-slate-25'
                      )}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="relative">
                            {member.avatar ? (
                              <img src={member.avatar} alt={fullName} className="w-8 h-8 rounded-full object-cover" />
                            ) : (
                              <div className={cn("w-8 h-8 rounded-full flex items-center justify-center", roleStyle.bg)}>
                                <span className={cn("text-xs font-bold", roleStyle.text)}>{initial}</span>
                              </div>
                            )}
                            <span
                              className={cn(
                                "absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white",
                                member.is_active_employee ? 'bg-emerald-500' : 'bg-slate-300'
                              )}
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{fullName}</p>
                            <p className="text-[10px] text-slate-500 md:hidden">{member.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn(
                          "text-[10px] font-medium px-2 py-1 rounded-full",
                          roleStyle.bg, roleStyle.text
                        )}>
                          {ROLE_LABELS[member.role]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <div className="space-y-0.5">
                          <p className="text-xs text-slate-600">{member.email || '-'}</p>
                          {member.phone && (
                            <p className="text-[10px] text-slate-500">{member.phone}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        <p className="text-xs text-slate-600 truncate max-w-[150px]">
                          {member.branch_name || '-'}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn(
                          "text-[10px] font-medium px-2 py-1 rounded-full",
                          member.is_active_employee ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                        )}>
                          {member.is_active_employee ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <Link
                          href={`/app/counselors/${member.id}`}
                          className="inline-flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 font-medium"
                        >
                          View <ChevronRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2.5 bg-slate-50 border-t border-slate-200">
            <p className="text-xs text-slate-500">
              Showing {filteredMembers.length} of {teamMembers.length} team members
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
