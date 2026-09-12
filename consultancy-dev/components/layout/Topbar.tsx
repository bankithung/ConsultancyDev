'use client';

import { Bell, Building2, Menu, User } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { Menu as HeadlessMenu, Transition } from '@headlessui/react';
import { Fragment, useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { toArray } from '@/components/common/pagination';
import { useUIStore } from '@/store/uiStore';

/**
 * Chat was removed from the product, so the message button, its socket-backed
 * unread badge and the ChatList panel are gone. Notifications remain and are
 * POLLED — they are created server-side, and there is no socket to push them.
 */

// Route to page title mapping
const PAGE_TITLES: Record<string, string> = {
  '/app/dashboard': 'Dashboard',
  '/app/tasks': 'Tasks',
  '/app/students': 'Students Directory',
  '/app/my-students': 'My Students',
  '/app/follow-ups': 'Follow-ups',
  '/app/engagements': 'Engagements',
  '/app/admissions': 'Admissions',
  '/app/enquiries/new': 'New Enquiry',
  '/app/registrations/new': 'New Registration',
  '/app/enrollments/new': 'New Enrollment',
  '/app/documents': 'Documents',
  '/app/payments': 'Payments',
  '/app/transfers': 'Handover',
  '/app/mcp': 'AI connections',
  '/app/appointments': 'Appointments',
  '/app/universities': 'University Database',
  '/app/team': 'Team & Branches',
  '/app/settings': 'Settings',
  '/app/profile': 'My Profile',
  '/app/notifications': 'Notifications',
  '/app/approval-requests': 'Approvals',
  '/app/my-requests': 'My Requests',
  '/app/chat': 'Chat',
  '/app/student-profile': 'Student Profile',
};

// Route to page subtitle mapping
const PAGE_SUBTITLES: Record<string, string> = {
  '/app/students': 'View and manage all students across every stage',
  '/app/my-students': 'Manage enquiries and registrations assigned to you',
  '/app/follow-ups': 'Manage and track your communications',
  '/app/engagements': 'Follow-ups and appointments in one place',
  '/app/admissions': 'Enquiries, registrations and enrollments in one place',
  '/app/enquiries/new': 'Create a new student enquiry',
  '/app/registrations/new': 'Register a new student',
  '/app/enrollments/new': 'Enroll a registered student',
  '/app/documents': 'Manage, track, and transfer student documents',
  '/app/payments': 'Manage financial transactions and history',
  '/app/appointments': 'Schedule and manage appointments',
  '/app/universities': 'Browse and manage university partnerships',
  '/app/team': 'Manage people and branches',
  '/app/settings': 'Manage your company profile and preferences',
  '/app/profile': 'View and edit your profile',
  '/app/notifications': 'Stay updated with important events',
  '/app/my-requests': 'Track status of your approval requests',
  '/app/chat': 'Team communication',
};

interface TopbarProps {
  onMenuClick: () => void;
}

export function Topbar({ onMenuClick }: TopbarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuthStore();
  const isDashboard = pathname === '/app/dashboard';
  const dashboardBranch = user && (
    ['DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER'].includes(user.role)
      ? 'All branches'
      : user.branch_name?.trim() || 'Branch not assigned'
  );

  // Calculate page title based on current path
  const { pageTitle: dynamicPageTitle } = useUIStore();

  // Calculate page title based on current path
  const pageTitle = useMemo(() => {
    if (dynamicPageTitle) return dynamicPageTitle;

    // Exact match first
    if (PAGE_TITLES[pathname]) {
      return PAGE_TITLES[pathname];
    }

    // Check for partial matches (for dynamic routes like /app/enquiries/123)
    const pathParts = pathname.split('/');
    for (let i = pathParts.length; i > 0; i--) {
      const partialPath = pathParts.slice(0, i).join('/');
      if (PAGE_TITLES[partialPath]) {
        return PAGE_TITLES[partialPath];
      }
    }

    // Fallback: generate title from last path segment
    const lastSegment = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
    if (lastSegment && lastSegment !== 'app') {
      return lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1).replace(/-/g, ' ');
    }

    return 'Dashboard';
  }, [pathname, dynamicPageTitle]);

  // Calculate page subtitle based on current path
  const pageSubtitle = useMemo(() => {
    // Exact match first
    if (PAGE_SUBTITLES[pathname]) {
      return PAGE_SUBTITLES[pathname];
    }

    // Check for partial matches (for dynamic routes)
    const pathParts = pathname.split('/');
    for (let i = pathParts.length; i > 0; i--) {
      const partialPath = pathParts.slice(0, i).join('/');
      if (PAGE_SUBTITLES[partialPath]) {
        return PAGE_SUBTITLES[partialPath];
      }
    }

    return '';
  }, [pathname]);

  // Polled, not pushed. `queryFn` is a thunk because `list` takes PageParams —
  // passing the reference directly hands it react-query's context object.
  const notificationsQuery = useQuery({
    queryKey: ['notifications', 'topbar'],
    queryFn: () => apiClient.notifications.list({ page_size: 10, ordering: '-created_at' }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const notifications = toArray(notificationsQuery.data);

  // The unread badge must count EVERY unread notification, not just the unread
  // ones on the first page, so it comes from the dedicated count endpoint.
  const unreadCountQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => apiClient.notifications.unreadCount(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const notificationCount = unreadCountQuery.data ?? 0;

  // Fetch tasks for stats (only when on tasks page)
  const isTasksPage = pathname === '/app/tasks';
  const tasksQuery = useQuery({
    queryKey: ['tasks', 'topbar-stats'],
    // page_size 200 is the server cap; the header counter is a summary, and
    // the Tasks page itself owns the full paginated list.
    queryFn: () => apiClient.tasks.list({ page_size: 200 }),
    enabled: isTasksPage,
    staleTime: 30_000,
  });

  // Calculate task stats
  const taskStats = useMemo(() => {
    if (!isTasksPage) return null;
    const tasks = toArray(tasksQuery.data);
    if (tasks.length === 0) return null;
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'Done').length,
      inProgress: tasks.filter((t) => t.status === 'In Progress').length,
    };
  }, [tasksQuery.data, isTasksPage]);

  return (
    <>
      <header className="bg-white border-b border-gray-200 h-16 flex items-center justify-between px-4 sticky top-0 z-50 shadow-sm transition-all duration-200">
        <div className="flex min-w-0 items-center flex-1">
          <button onClick={onMenuClick} className="md:hidden p-2 rounded-md hover:bg-gray-100 mr-2 text-gray-600 transition-colors">
            <Menu size={20} />
          </button>

          <div className={`${isDashboard ? 'flex' : 'hidden md:flex'} min-w-0 flex-col`}>
            <span className="text-lg font-bold text-gray-800 font-heading tracking-tight leading-tight">{pageTitle}</span>
            <div className="flex items-center gap-3">
              {isDashboard && dashboardBranch && <span data-testid="dashboard-branch" title={dashboardBranch} className="flex min-w-0 items-center gap-1 text-xs font-medium leading-tight text-teal-700"><Building2 size={12} className="shrink-0" /><span className="truncate">{dashboardBranch}</span></span>}
              {pageSubtitle && <span className="text-xs text-gray-500 leading-tight">{pageSubtitle}</span>}
              {/* Task Stats for Tasks Page */}
              {taskStats && (
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-teal-600 font-medium">{taskStats.completed}/{taskStats.total} completed</span>
                  {taskStats.inProgress > 0 && (
                    <span className="text-blue-600 font-medium">{taskStats.inProgress} in progress</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="ml-3 flex shrink-0 items-center space-x-4">
          {/* Notifications */}
          <HeadlessMenu as="div" className="relative">
            <HeadlessMenu.Button
              className="p-2 rounded-full hover:bg-gray-100 text-gray-500 relative group focus:outline-none"
              title="Notifications"
            >
              <Bell size={20} className="group-hover:text-teal-600 transition-colors" />
              {notificationCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-white">
                  {notificationCount}
                </span>
              )}
            </HeadlessMenu.Button>
            <Transition
              as={Fragment}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <HeadlessMenu.Items className="absolute right-0 z-20 mt-2 w-96 origin-top-right rounded-xl bg-white shadow-xl ring-1 ring-black ring-opacity-5 focus:outline-none border border-slate-100 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex justify-between items-center bg-white">
                  <h3 className="text-sm font-semibold text-slate-800">Notifications</h3>
                  {notificationCount > 0 && (
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100">
                      {notificationCount} New
                    </span>
                  )}
                </div>

                <div className="max-h-[380px] overflow-y-auto">
                  {notifications.length > 0 ? (
                    <div className="divide-y divide-slate-50">
                      {notifications.slice(0, 5).map((notification) => (
                        <HeadlessMenu.Item key={notification.id}>
                          {({ active }) => (
                            <Link
                              href={notification.actionUrl || '/app/notifications'}
                              className={`block px-4 py-3.5 transition-all duration-200 relative ${active ? 'bg-slate-50' : 'bg-white'
                                } ${!notification.read ? 'bg-slate-50/50' : ''}`}
                            >
                              {!notification.read && (
                                <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500 rounded-r" />
                              )}
                              <div className="flex gap-3.5 pl-1">
                                <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${!notification.read ? 'bg-emerald-500 ring-2 ring-emerald-100' : 'bg-slate-300'}`} />
                                <div className="flex-1 min-w-0">
                                  <p className={`text-sm leading-snug mb-1 ${!notification.read ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>
                                    {notification.title}
                                  </p>
                                  <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                                    {notification.message}
                                  </p>
                                  <p className="text-[10px] text-slate-400 mt-2 font-medium">
                                    {new Date(notification.created_at).toLocaleDateString(undefined, {
                                      month: 'short',
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })}
                                  </p>
                                </div>
                              </div>
                            </Link>
                          )}
                        </HeadlessMenu.Item>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                      <div className="bg-slate-50 p-3 rounded-full mb-3">
                        <Bell size={24} className="text-slate-300" />
                      </div>
                      <p className="text-sm font-medium text-slate-500">No new notifications</p>
                    </div>
                  )}
                </div>

                <div className="bg-slate-50 border-t border-slate-100 p-2">
                  <HeadlessMenu.Item>
                    {({ active }) => (
                      <Link
                        href="/app/notifications"
                        className={`block w-full text-center px-4 py-2 text-xs font-semibold text-slate-600 hover:text-emerald-600 hover:bg-white border border-transparent hover:border-slate-200 rounded-lg transition-all duration-200 ${active ? 'bg-white border-slate-200 text-emerald-600 shadow-sm' : ''}`}
                      >
                        View All Notifications
                      </Link>
                    )}
                  </HeadlessMenu.Item>
                </div>
              </HeadlessMenu.Items>
            </Transition>
          </HeadlessMenu>

          {/* Profile Dropdown */}
          <HeadlessMenu as="div" className="relative ml-3">
            <div>
              <HeadlessMenu.Button className="flex max-w-xs items-center rounded-full bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2">
                <span className="sr-only">Open user menu</span>
                {user?.avatar ? (
                  <img className="h-8 w-8 rounded-full ring-2 ring-gray-100" src={user.avatar} alt="" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 ring-2 ring-teal-50">
                    <User size={16} />
                  </div>
                )}
              </HeadlessMenu.Button>
            </div>
            <Transition
              as={Fragment}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <HeadlessMenu.Items className="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-white py-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none border border-gray-100">
                <HeadlessMenu.Item>
                  {({ active }) => (
                    <Link
                      href="/app/profile"
                      className={`${active ? 'bg-gray-50' : ''} block px-4 py-2 text-sm text-gray-700 font-body`}
                    >
                      Your Profile
                    </Link>
                  )}
                </HeadlessMenu.Item>
                <HeadlessMenu.Item>
                  {({ active }) => (
                    <Link
                      href="/app/settings"
                      className={`${active ? 'bg-gray-50' : ''} block px-4 py-2 text-sm text-gray-700 font-body`}
                    >
                      Settings
                    </Link>
                  )}
                </HeadlessMenu.Item>
                <HeadlessMenu.Item>
                  {({ active }) => (
                    <button
                      onClick={() => logout()}
                      className={`${active ? 'bg-gray-50' : ''} block w-full text-left px-4 py-2 text-sm text-gray-700 font-body`}
                    >
                      Sign out
                    </button>
                  )}
                </HeadlessMenu.Item>
              </HeadlessMenu.Items>
            </Transition>
          </HeadlessMenu>
        </div>
      </header>
    </>
  );
}
