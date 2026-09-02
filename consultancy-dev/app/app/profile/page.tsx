'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Building,
  Calendar,
  ChevronRight,
  Clock,
  FileText,
  Key,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Shield,
  Target,
  UserRound,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/common/Modal';
import { ErrorBanner, InlineSpinner, LoadingState } from '@/components/common/states';
import { ROLE_LABELS, roleLabel } from '@/components/rbac/roles';
import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/authStore';
import { toast } from '@/store/toastStore';
import { isRole } from '@/lib/types';
import { ApiKeysCard } from './components/ApiKeysCard';

/**
 * The signed-in user's own profile.
 *
 * Two backend constraints drive the shape of this page:
 *
 * 1. `role`, `company` and `branch` are read-only on the profile serializer —
 *    they are only assignable by an admin from /app/users, so they are shown
 *    but never offered as inputs here.
 * 2. A self-service password change MUST go through
 *    `users/change-password/`, which verifies the current password. A bare
 *    PATCH of `{password}` is refused for non-admins.
 */

interface ProfileForm {
  first_name: string;
  last_name: string;
  phone: string;
}

interface PasswordForm {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

const EMPTY_PASSWORD_FORM: PasswordForm = {
  current_password: '',
  new_password: '',
  confirm_password: '',
};

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

function InfoItem({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      {Icon && <Icon size={14} className="mt-0.5 shrink-0 text-slate-400" />}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
        <p className="break-words text-sm text-slate-800">{value || '—'}</p>
      </div>
    </div>
  );
}

const QUICK_ACTIONS = [
  { href: '/app/my-students', label: 'My students', icon: Users },
  { href: '/app/tasks', label: 'My tasks', icon: Target },
  { href: '/app/follow-ups', label: 'Follow-ups', icon: Clock },
  { href: '/app/documents', label: 'Documents', icon: FileText },
] as const;

export default function ProfilePage() {
  const { user } = useAuth();
  const checkAuth = useAuthStore((state) => state.checkAuth);

  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<ProfileForm>({ first_name: '', last_name: '', phone: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string>>({});

  const userId = user?.id;
  // `owner` is one of the few filters these endpoints actually declare, so the
  // counts come off the pagination envelope rather than from downloading every
  // row and filtering in the browser.
  const ownerFilter = userId === undefined ? undefined : { owner: userId };

  const myEnquiries = useQuery({
    queryKey: ['enquiries', 'mine', userId],
    queryFn: () => apiClient.enquiries.list({ page_size: 1, filters: ownerFilter }),
    enabled: userId !== undefined,
  });

  const myRegistrations = useQuery({
    queryKey: ['registrations', 'mine', userId],
    queryFn: () => apiClient.registrations.list({ page_size: 1, filters: ownerFilter }),
    enabled: userId !== undefined,
  });

  const myTransfers = useQuery({
    queryKey: ['transfers', 'inbox', 'count'],
    queryFn: () => apiClient.transfers.inbox({ page_size: 1 }),
    enabled: userId !== undefined,
  });

  // Seeds the form from the signed-in user and re-seeds whenever the stored
  // user changes (`checkAuth` replaces the object after a save).
  //
  // Adjusted during render rather than in an effect: React re-runs this
  // component immediately with the corrected state, so nothing is ever painted
  // from stale values. An effect would render once with the old form first, and
  // the project's lint rules reject setState inside one. The `isEditing` guard
  // keeps a background refresh from overwriting what the user is typing.
  const userSignature = user
    ? `${user.id}|${user.first_name}|${user.last_name}|${user.phone ?? ''}`
    : '';
  const [seededSignature, setSeededSignature] = useState<string | null>(null);
  if (user && !isEditing && seededSignature !== userSignature) {
    setSeededSignature(userSignature);
    setForm({ first_name: user.first_name, last_name: user.last_name, phone: user.phone ?? '' });
  }

  const updateProfile = useMutation({
    mutationFn: (payload: ProfileForm) => {
      if (!user) throw new Error('You are not signed in.');
      return apiClient.users.update(user.id, {
        first_name: payload.first_name.trim(),
        last_name: payload.last_name.trim(),
        phone: payload.phone.trim(),
      });
    },
    onSuccess: async () => {
      // Refreshes the store so the header and every role check see the new name.
      await checkAuth();
      setIsEditing(false);
      setFieldErrors({});
      toast.success('Profile updated');
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const changePassword = useMutation({
    mutationFn: (payload: PasswordForm) =>
      apiClient.users.changePassword(payload.current_password, payload.new_password),
    onSuccess: () => {
      setIsPasswordOpen(false);
      setPasswordForm(EMPTY_PASSWORD_FORM);
      setPasswordFieldErrors({});
      setPasswordError(null);
      toast.success('Password changed', 'Use your new password the next time you sign in.');
    },
    onError: (error: unknown) => setPasswordFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  const cancelEdit = () => {
    setIsEditing(false);
    setFieldErrors({});
    updateProfile.reset();
    if (user) {
      setForm({ first_name: user.first_name, last_name: user.last_name, phone: user.phone ?? '' });
    }
  };

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordFieldErrors({});
    if (!passwordForm.current_password) {
      setPasswordError('Enter your current password — the server verifies it.');
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordError('The two new passwords do not match.');
      return;
    }
    if (passwordForm.new_password.length < 8) {
      setPasswordError('Use at least 8 characters.');
      return;
    }
    setPasswordError(null);
    changePassword.mutate(passwordForm);
  };

  const openPasswordModal = () => {
    setPasswordForm(EMPTY_PASSWORD_FORM);
    setPasswordError(null);
    setPasswordFieldErrors({});
    changePassword.reset();
    setIsPasswordOpen(true);
  };

  if (!user) {
    return <LoadingState rows={3} label="Loading your profile" />;
  }

  const fullName = user.full_name.trim() || user.username;
  const initials =
    fullName
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?';

  const roleText = user.role_display || (isRole(user.role) ? ROLE_LABELS[user.role] : roleLabel(user.role));

  const stats = [
    { label: 'Enquiries', value: myEnquiries.data?.count ?? 0, loading: myEnquiries.isLoading },
    { label: 'Registrations', value: myRegistrations.data?.count ?? 0, loading: myRegistrations.isLoading },
    { label: 'Transfers in', value: myTransfers.data?.count ?? 0, loading: myTransfers.isLoading },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-heading text-2xl font-bold text-slate-900">My profile</h1>
          <p className="mt-1 font-body text-sm text-slate-600">Your details and sign-in security</p>
        </div>
        <Button variant="outline" onClick={openPasswordModal} className="h-10 w-full gap-2 sm:w-auto">
          <Key size={14} /> Change password
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <Card className="overflow-hidden border-slate-200">
            <div className="h-16 bg-gradient-to-br from-slate-800 to-slate-900" />
            <CardContent className="-mt-8 px-4 pb-4 pt-0">
              <div className="flex flex-col items-center text-center">
                {user.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element -- avatars are absolute URLs from the API, not local assets
                  <img
                    src={user.avatar}
                    alt=""
                    className="h-16 w-16 rounded-full border-4 border-white object-cover shadow-sm"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-white bg-slate-700 shadow-sm">
                    <span className="text-lg font-bold text-white">{initials}</span>
                  </div>
                )}
                <h2 className="mt-2 break-words text-base font-semibold text-slate-900">{fullName}</h2>
                <p className="text-xs text-slate-500">@{user.username}</p>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <Badge className="border-transparent bg-slate-100 text-slate-700 hover:bg-slate-100">
                    {roleText}
                  </Badge>
                  <Badge
                    className={
                      user.is_active_employee
                        ? 'border-transparent bg-green-100 text-green-700 hover:bg-green-100'
                        : 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100'
                    }
                  >
                    {user.is_active_employee ? 'Active' : 'Deactivated'}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardContent className="p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</h3>
              <div className="space-y-1">
                <InfoItem label="Email" value={user.email} icon={Mail} />
                <InfoItem label="Phone" value={user.phone ?? ''} icon={Phone} />
                <InfoItem label="Branch" value={user.branch_name ?? 'Not assigned'} icon={MapPin} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardContent className="p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Assigned to me
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {stats.map((stat) => (
                  <div key={stat.label} className="rounded-lg bg-slate-50 p-2 text-center">
                    <p className="text-lg font-bold text-slate-800">
                      {stat.loading ? <span className="text-slate-300">…</span> : stat.value}
                    </p>
                    <p className="text-[10px] leading-tight text-slate-500">{stat.label}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">Personal information</h3>
                {!isEditing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setIsEditing(true)}
                    className="h-8 gap-1.5 text-xs text-slate-600"
                  >
                    <Pencil size={12} /> Edit
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={cancelEdit} className="h-8 text-xs">
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setFieldErrors({});
                        updateProfile.mutate(form);
                      }}
                      disabled={updateProfile.isPending}
                      className="h-8 bg-slate-900 text-xs text-white hover:bg-slate-800"
                    >
                      {updateProfile.isPending ? <InlineSpinner /> : 'Save'}
                    </Button>
                  </div>
                )}
              </div>

              {updateProfile.isError && (
                <div className="mb-3">
                  <ErrorBanner error={updateProfile.error} onDismiss={() => updateProfile.reset()} />
                </div>
              )}

              <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                {(
                  [
                    { key: 'first_name', label: 'First name' },
                    { key: 'last_name', label: 'Last name' },
                    { key: 'phone', label: 'Phone' },
                  ] as const
                ).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`profile-${field.key}`} className="text-[10px] uppercase tracking-wide text-slate-400">
                      {field.label}
                    </Label>
                    {isEditing ? (
                      <Input
                        id={`profile-${field.key}`}
                        type={field.key === 'phone' ? 'tel' : 'text'}
                        className="h-10 text-sm"
                        value={form[field.key]}
                        onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      />
                    ) : (
                      <p className="break-words py-1 text-sm text-slate-800">{form[field.key] || '—'}</p>
                    )}
                    {fieldErrors[field.key] && (
                      <p className="text-xs text-red-600">{fieldErrors[field.key]}</p>
                    )}
                  </div>
                ))}
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-slate-400">Username</Label>
                  <p className="break-words py-1 text-sm text-slate-500">@{user.username}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardContent className="p-4">
              <h3 className="mb-1 text-sm font-semibold text-slate-900">Work information</h3>
              <p className="mb-3 text-xs text-slate-500">
                Set by a company admin. Ask them if any of this is wrong.
              </p>
              <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                <InfoItem label="Role" value={roleText} icon={Shield} />
                <InfoItem label="Company" value={user.company_name ?? '—'} icon={Building} />
                <InfoItem label="Branch" value={user.branch_name ?? 'Not assigned'} icon={MapPin} />
                <InfoItem label="Last sign-in" value={formatDateTime(user.last_login)} icon={Calendar} />
                <InfoItem
                  label="Account status"
                  value={user.is_active_employee ? 'Active' : 'Deactivated'}
                  icon={UserRound}
                />
              </div>
            </CardContent>
          </Card>

          <ApiKeysCard />

          <Card className="border-slate-200">
            <CardContent className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-900">Quick actions</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {QUICK_ACTIONS.map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 p-2.5 text-xs text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    <action.icon size={14} className="shrink-0 text-slate-400" />
                    <span className="truncate">{action.label}</span>
                    <ChevronRight size={12} className="ml-auto shrink-0 text-slate-300" />
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Modal
        open={isPasswordOpen}
        onClose={() => setIsPasswordOpen(false)}
        size="sm"
        title="Change password"
        description="Your current password is required — this is a self-service change, not an admin reset."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:w-28"
              onClick={() => setIsPasswordOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="password-form"
              className="h-11 bg-slate-900 hover:bg-slate-800 sm:w-40"
              disabled={changePassword.isPending}
            >
              {changePassword.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Changing…
                </>
              ) : (
                'Change password'
              )}
            </Button>
          </div>
        }
      >
        <form id="password-form" className="space-y-4" onSubmit={submitPassword}>
          {passwordError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              {passwordError}
            </p>
          )}
          {changePassword.isError && <ErrorBanner error={changePassword.error} />}

          {(
            [
              { key: 'current_password', label: 'Current password', autoComplete: 'current-password' },
              { key: 'new_password', label: 'New password', autoComplete: 'new-password' },
              { key: 'confirm_password', label: 'Confirm new password', autoComplete: 'new-password' },
            ] as const
          ).map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                type="password"
                autoComplete={field.autoComplete}
                className="h-11"
                value={passwordForm[field.key]}
                onChange={(e) => setPasswordForm({ ...passwordForm, [field.key]: e.target.value })}
              />
              {passwordFieldErrors[field.key] && (
                <p className="text-xs text-red-600">{passwordFieldErrors[field.key]}</p>
              )}
            </div>
          ))}

          <p className="text-xs text-slate-500">
            If this signs you out, sign back in with the new password.
          </p>
        </form>
      </Modal>
    </div>
  );
}
