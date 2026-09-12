'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  GraduationCap,
  FileText,
  FolderOpen,
  Clock,
  CreditCard,
  BarChart3,
  Settings,
  Users,
  Server,
  Bot,
  CheckSquare,
  X,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Building2,
  ArrowLeftRight,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { ALL_ROLES, hasRole, ROLES, roleLabel } from '@/components/rbac/roles';
import { DOCUMENTS_PATH, resolveTab, sectionForTab, type DocumentSection } from '@/app/app/documents/tabs';
import type { Role } from '@/lib/types';

interface SidebarProps {
  isOpen: boolean;
  isMobile: boolean;
  onCloseMobile: () => void;
  toggleCollapse: () => void;
  isCollapsed: boolean;
}

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /**
   * Set only on entries that share a pathname with their siblings and are told
   * apart by `?tab=`. A predicate rather than a literal tab, because the two
   * groups need different rules: Documents maps several tabs onto one child
   * and honours historic aliases, Engagements matches the parameter outright.
   */
  matchesTab?: (tab: string | null) => boolean;
}

/** A parent that expands. It is not a link: there is no page behind it. */
interface NavGroup {
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  /**
   * Everything below this path belongs to the group, including the routes no
   * child points at — /app/documents/expiry and the transfer detail pages.
   * The flat entry this group replaced lit up on those, and without it they
   * would leave the whole sidebar unlit.
   */
  basePath: string;
  children: NavItem[];
}

type NavEntry = NavItem | NavGroup;

interface NavSection {
  heading: string | null;
  items: NavEntry[];
}

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

const EVERYONE = ALL_ROLES;
const MANAGERS_UP = [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER] as const;
const ADMINS = [ROLES.DEV_ADMIN, ROLES.COMPANY_ADMIN] as const;

/**
 * Navigation is filtered by role so nobody is offered a page the API will
 * refuse. This is a usability measure only — the backend enforces access.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    heading: null,
    items: [
      { label: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard, roles: EVERYONE },
      { label: 'Tasks', href: '/app/tasks', icon: CheckSquare, roles: EVERYONE },
      // One entry: "mine" and "everyone" are tabs on the same screen now, so
      // two nav items pointed at the same page. EVERYONE rather than
      // MANAGERS_UP — an employee lands on their own students and simply is
      // not offered the second tab.
      { label: 'Students', href: '/app/students', icon: Users, roles: EVERYONE },
      // One entry for the whole intake pipeline. Enquiries, registrations and
      // enrollments are the same student at three points in it, and they are
      // now three tabs on one screen — so three nav items pointed at what is
      // really one destination.
      { label: 'Admissions', href: '/app/admissions', icon: GraduationCap, roles: EVERYONE },
      { label: 'Handover', href: '/app/transfers', icon: ArrowLeftRight, roles: EVERYONE },
      // Follow-ups and appointments are both scheduled contact with the same
      // prospective student, a call and a meeting, so they are two tabs on one
      // screen rather than two destinations. FLAT, unlike Documents: the page's
      // own bookmark tabs already offer the choice, and a nav child per tab
      // would be a second copy of the same two options. With no `matchesTab`
      // this falls through to `isActiveHref`, which ignores the query — so the
      // one row lights up for every `?tab=` value, which is what we want here.
      { label: 'Engagements', href: '/app/engagements', icon: CalendarClock, roles: EVERYONE },
      // The opposite call to Admissions, for the opposite reason. A scan and
      // the original paper are different records on different endpoints, and
      // "which of the two am I looking at" is the question this screen exists
      // to answer — so the split is promoted into the nav instead of being
      // buried in a five-tab rail. The parent has no page of its own: landing
      // on it would mean picking one of the three arbitrarily.
      {
        label: 'Documents',
        icon: FileText,
        roles: EVERYONE,
        basePath: DOCUMENTS_PATH,
        children: (
          [
            { label: 'Digital', section: 'digital', icon: FileText },
            { label: 'Physical', section: 'physical', icon: FolderOpen },
            { label: 'Tracking', section: 'tracking', icon: Clock },
          ] as ReadonlyArray<{ label: string; section: DocumentSection; icon: LucideIcon }>
        ).map(({ label, section, icon }) => ({
          label,
          href: `${DOCUMENTS_PATH}?tab=${section}`,
          icon,
          roles: EVERYONE,
          // Through `resolveTab` so a historic alias highlights the same child
          // the page opens, and on the SECTION so `?tab=physical-transfer`
          // lights up Physical rather than nothing.
          matchesTab: (tab: string | null) => sectionForTab(resolveTab(tab)) === section,
        })),
      },
      // Refunds is a tab on Payments now; its own route is a redirect.
      { label: 'Payments', href: '/app/payments', icon: CreditCard, roles: EVERYONE },
      { label: 'Universities', href: '/app/universities', icon: Building2, roles: EVERYONE },
      // HIDDEN, NOT CUT: /app/visa-tracking and /app/templates are both still
      // built and still routable — the user simply has no use for them yet.
      // Restoring either is one line here.
      { label: 'My Requests', href: '/app/my-requests', icon: CheckSquare, roles: [ROLES.EMPLOYEE] },
    ],
  },
  {
    heading: 'Insights',
    items: [{ label: 'Analytics', href: '/app/analytics', icon: BarChart3, roles: MANAGERS_UP }],
  },
  {
    heading: 'Management',
    items: [
      // One roster. `Users` (accounts) and `Counselors` (the same payload as
      // cards) were two doors onto it; the write controls inside are gated on
      // `manageUsers`, so a head manager reads it and changes nothing.
      { label: 'Team & Branches', href: '/app/team', icon: Users, roles: [...ADMINS, ROLES.HEAD_MANAGER, ROLES.BRANCH_MANAGER] },
      // Beside Users on purpose: that screen says who exists and which role
      // they hold, this one says what a role can do. FLAT rather than a child
      // of Settings — `isActiveHref` treats a path as owning everything nested
      // under it, so /app/settings/permissions would light Settings too.
      { label: 'Permissions', href: '/app/permissions', icon: ShieldCheck, roles: ADMINS },
      { label: 'Approvals', href: '/app/approval-requests', icon: CheckSquare, roles: [...ADMINS, ROLES.HEAD_MANAGER] },
      { label: 'Settings', href: '/app/settings', icon: Settings, roles: ADMINS },
    ],
  },
  {
    heading: 'Connections',
    items: [{ label: 'Connect AI / MCP', href: '/app/mcp', icon: Bot, roles: EVERYONE }],
  },
  {
    heading: 'Platform',
    items: [
      { label: 'Companies', href: '/app/companies', icon: Building2, roles: [ROLES.DEV_ADMIN] },
      { label: 'Signup Requests', href: '/app/dev-tools/signup-requests', icon: Server, roles: [ROLES.DEV_ADMIN] },
    ],
  },
];

/**
 * An entry owns its own path and everything nested UNDER it, but not paths
 * that merely start with the same letters: the trailing slash is what keeps
 * /app/team from lighting up on /app/team-something. The Documents group
 * leans on the nested half of this for /app/documents/expiry and the transfer
 * detail routes, so narrowing it to an exact match would unlight those.
 */
function isActiveHref(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

/**
 * `usePathname()` never carries the query, so a group's children — all of them
 * on one path — would light up together under a pathname comparison.
 *
 * Those entries are matched by their own `matchesTab` instead, against the
 * bare path taken from their href. Each group supplies the rule its page
 * actually uses, which is the only way one function can serve both a page with
 * five tabs collapsed onto three children and a page with two of each.
 */
function isActiveItem(pathname: string, tabParam: string | null, item: NavItem): boolean {
  if (item.matchesTab === undefined) return isActiveHref(pathname, item.href);
  return pathname === item.href.split('?')[0] && item.matchesTab(tabParam);
}

function NavLink({
  item,
  isCollapsed,
  isActive,
  isNested = false,
  onNavigate,
}: {
  item: NavItem;
  isCollapsed: boolean;
  isActive: boolean;
  isNested?: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      title={isCollapsed ? item.label : undefined}
      className={cn(
        'group flex items-center rounded-md px-3 py-2 transition-colors',
        isNested && 'py-1.5 pl-9',
        isActive ? 'bg-teal-50 text-teal-600' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        isCollapsed && 'justify-center',
      )}
    >
      <Icon
        size={isNested ? 16 : 20}
        className={cn('shrink-0', isActive ? 'text-teal-600' : 'text-muted-foreground group-hover:text-accent-foreground')}
      />
      {!isCollapsed && <span className={cn('truncate', isNested ? 'ml-2' : 'ml-3')}>{item.label}</span>}
    </Link>
  );
}

function NavGroupBlock({
  group,
  isCollapsed,
  pathname,
  tabParam,
  onNavigate,
  onExpandSidebar,
}: {
  group: NavGroup;
  isCollapsed: boolean;
  pathname: string;
  tabParam: string | null;
  onNavigate: () => void;
  onExpandSidebar: () => void;
}) {
  const containsActive =
    isActiveHref(pathname, group.basePath) ||
    group.children.some((child) => isActiveItem(pathname, tabParam, child));
  const panelId = `nav-group-${group.label.toLowerCase().replace(/\s+/g, '-')}`;
  const Icon = group.icon;

  /**
   * Openness FOLLOWS THE ROUTE unless the user has said otherwise, rather than
   * being copied into state and resynced by an effect. That is what makes a
   * deep link or a hard reload of `?tab=physical` arrive with the group
   * already open: nothing has to run after paint to put it there.
   *
   * `null` means "follow the route"; a toggle pins it until the user clicks
   * again or reloads. So the only way to land inside the group and find it
   * shut is to have shut it yourself, and the parent still shows teal then.
   */
  const [pinnedOpen, setPinnedOpen] = useState<boolean | null>(null);
  const isOpen = pinnedOpen ?? containsActive;
  // The 80px rail has no room for the children, so it is this — not `isOpen` —
  // that `aria-expanded` must report: claiming expanded while nothing is shown
  // would send a screen-reader user looking for links that are not there.
  const showsChildren = isOpen && !isCollapsed;

  const handleToggle = () => {
    if (isCollapsed) {
      // 80px of rail has no room for nested labels, so the honest response to
      // a click here is to make room for them. Toggling state nobody can see
      // would read as a dead button.
      onExpandSidebar();
      setPinnedOpen(true);
      return;
    }
    setPinnedOpen(!isOpen);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={showsChildren}
        aria-controls={panelId}
        title={isCollapsed ? group.label : undefined}
        className={cn(
          'group flex w-full items-center rounded-md px-3 py-2 transition-colors',
          containsActive
            ? 'text-teal-600'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          isCollapsed && 'justify-center',
        )}
      >
        <Icon
          size={20}
          className={cn(
            'shrink-0',
            containsActive ? 'text-teal-600' : 'text-muted-foreground group-hover:text-accent-foreground',
          )}
        />
        {!isCollapsed && (
          <>
            <span className="ml-3 flex-1 truncate text-left">{group.label}</span>
            <ChevronDown size={16} className={cn('shrink-0 transition-transform', isOpen && 'rotate-180')} />
          </>
        )}
      </button>

      {/*
        Unmounted when closed rather than hidden, so no link inside it stays in
        the tab order while out of sight. `aria-expanded` on the button is then
        the whole of the state, and `aria-controls` simply has nothing to point
        at until it opens.
      */}
      <AnimatePresence initial={false}>
        {showsChildren && (
          <motion.div
            key="children"
            id={panelId}
            role="group"
            aria-label={group.label}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-1 space-y-1">
              {group.children.map((child) => (
                <NavLink
                  key={child.href}
                  item={child}
                  isCollapsed={false}
                  isNested
                  isActive={isActiveItem(pathname, tabParam, child)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SidebarContent({
  isCollapsed,
  isMobile,
  onCloseMobile,
  toggleCollapse,
}: {
  isCollapsed: boolean;
  isMobile: boolean;
  onCloseMobile: () => void;
  toggleCollapse: () => void;
}) {
  const pathname = usePathname();
  // Read rather than derived from the pathname: the Documents children differ
  // only by this parameter.
  const tabParam = useSearchParams().get('tab');
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const collapsed = isCollapsed && !isMobile;

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    // A group is filtered as a whole and then child by child, so a role that
    // may see none of the children is not offered an empty parent.
    items: section.items
      .filter((entry) => hasRole(user?.role, entry.roles))
      .map((entry) =>
        isGroup(entry)
          ? { ...entry, children: entry.children.filter((child) => hasRole(user?.role, child.roles)) }
          : entry,
      )
      .filter((entry) => !isGroup(entry) || entry.children.length > 0),
  })).filter((section) => section.items.length > 0);

  const displayName = user?.first_name || user?.username || 'User';

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const handleNavigate = () => {
    if (isMobile) onCloseMobile();
  };

  return (
    <div className="flex h-full flex-col border-r border-border bg-card text-sm font-medium">
      <div
        className={cn(
          'flex h-16 items-center border-b border-border px-4',
          collapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {!collapsed && <span className="truncate text-lg font-bold text-teal-600">Consultancy Dev</span>}
        {!isMobile && (
          <button
            onClick={toggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {isCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          </button>
        )}
        {isMobile && (
          <button
            onClick={onCloseMobile}
            aria-label="Close navigation menu"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X size={20} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        {sections.map((section, index) => (
          <div key={section.heading ?? `section-${index}`}>
            {section.heading &&
              (collapsed ? (
                <div className="my-3 border-t border-border" />
              ) : (
                <div className="mb-2 mt-6 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.heading}
                </div>
              ))}
            <nav className="space-y-1 px-2">
              {section.items.map((entry) =>
                isGroup(entry) ? (
                  <NavGroupBlock
                    key={entry.label}
                    group={entry}
                    isCollapsed={collapsed}
                    pathname={pathname}
                    tabParam={tabParam}
                    onNavigate={handleNavigate}
                    onExpandSidebar={toggleCollapse}
                  />
                ) : (
                  <NavLink
                    key={entry.href}
                    item={entry}
                    isCollapsed={collapsed}
                    isActive={isActiveItem(pathname, tabParam, entry)}
                    onNavigate={handleNavigate}
                  />
                ),
              )}
            </nav>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-4">
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'gap-3')}>
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-600">
              <span className="text-xs font-bold">{displayName.charAt(0).toUpperCase()}</span>
            </div>
          )}

          {!collapsed && (
            <>
              <Link href="/app/profile" onClick={handleNavigate} className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{roleLabel(user?.role)}</p>
              </Link>
              <button
                onClick={handleLogout}
                aria-label="Sign out"
                className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
              >
                <LogOut size={18} />
              </button>
            </>
          )}
        </div>
        {collapsed && (
          <button
            onClick={handleLogout}
            aria-label="Sign out"
            className="mt-4 flex w-full justify-center text-muted-foreground transition-colors hover:text-destructive"
          >
            <LogOut size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

export function Sidebar({ isOpen, isMobile, onCloseMobile, toggleCollapse, isCollapsed }: SidebarProps) {
  const contentProps = { isCollapsed, isMobile, onCloseMobile, toggleCollapse };

  if (isMobile) {
    return (
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onCloseMobile}
              className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
            />
            <motion.div
              key="sidebar"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="fixed inset-y-0 left-0 z-50 w-[min(16rem,85vw)] border-r border-border bg-card shadow-xl"
            >
              <SidebarContent {...contentProps} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    );
  }

  return (
    <motion.div
      animate={{ width: isCollapsed ? 80 : 256 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="sticky top-0 z-30 hidden h-screen flex-shrink-0 border-r border-border bg-card shadow-sm md:block"
    >
      <SidebarContent {...contentProps} />
    </motion.div>
  );
}
