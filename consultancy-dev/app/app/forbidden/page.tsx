'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldAlert, ArrowLeft, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/authStore';
import { roleLabel } from '@/components/rbac/roles';

/**
 * Landing page for the middleware's insufficient-role redirect.
 */
export default function ForbiddenPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
          <ShieldAlert className="h-8 w-8 text-amber-600" />
        </div>

        <h1 className="mt-6 text-2xl font-bold text-slate-900">Access restricted</h1>
        <p className="mt-3 text-sm text-slate-600">
          You do not have permission to view that page.
          {user && (
            <>
              {' '}
              Your account is signed in as{' '}
              <span className="font-semibold text-slate-900">{roleLabel(user.role)}</span>.
            </>
          )}
        </p>
        <p className="mt-2 text-sm text-slate-500">
          If you believe this is a mistake, ask your administrator to review your role or branch assignment.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button variant="outline" className="h-11 w-full sm:w-auto" onClick={() => router.back()}>
            <ArrowLeft size={16} className="mr-2" /> Go back
          </Button>
          <Button className="h-11 w-full bg-teal-600 hover:bg-teal-700 sm:w-auto" asChild>
            <Link href="/app/dashboard">
              <LayoutDashboard size={16} className="mr-2" /> Go to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
