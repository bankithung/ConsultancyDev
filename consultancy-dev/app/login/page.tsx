'use client';

import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuthStore } from '@/store/authStore';
import { AUTH_REASON_PARAM, authReasonMessage, AuthReason } from '@/lib/authReason';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle, BarChart3, Info } from 'lucide-react';
import Link from 'next/link';

/**
 * Whether the sign-in screen offers public self-registration.
 *
 * Off: staff accounts are created by an admin on the Users screen, so a
 * "Sign up" link here would invite people down a path that ends in a request
 * queue rather than an account.
 *
 * The `/signup` route and the whole signup-request workflow are intentionally
 * left intact — this only hides the entry point, so turning it back on is a
 * one-word change.
 */
const SHOW_PUBLIC_SIGNUP = false;

const loginSchema = z.object({
    username: z.string().min(1, 'Username or email is required'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

function LoginForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { login, isLoading, error: authError, clearError } = useAuthStore();
    const [localError, setLocalError] = useState<string | null>(null);

    // `?reason=` explains an involuntary sign-out. Routed through
    // authReasonMessage() rather than rendered raw — the value comes from the
    // URL, so anyone could otherwise choose what this page tells the user.
    const reason = searchParams.get(AUTH_REASON_PARAM);
    const reasonMessage = authReasonMessage(reason);
    // Revocation is not the user's fault, so it reads as information, not error.
    const reasonIsInformational = reason === AuthReason.SESSION_ENDED;

    /** Where to land after signing in, restricted to in-app paths. */
    const returnTo = (() => {
        const from = searchParams.get('from');
        return from && from.startsWith('/app/') ? from : '/app/dashboard';
    })();

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<LoginFormValues>({
        resolver: zodResolver(loginSchema),
        defaultValues: {
            username: '',
            password: '',
        },
    });

    const onSubmit = async (data: LoginFormValues) => {
        setLocalError(null);
        clearError();

        try {
            await login(data.username, data.password);
            router.push(returnTo);
        } catch {
            setLocalError('Invalid username/email or password');
        }
    };

    /*
     * A standalone sign-in screen: no marketing header or footer.
     *
     * This is a private tool, not a product website — every visitor is a member
     * of staff who is here to sign in. The landing chrome linked to Product /
     * Solutions / Pricing / About pages that no longer exist, so it was both
     * noise and a source of dead links.
     */
    return (
        <div className="min-h-screen bg-slate-50 flex flex-col">
            <div className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
                <div className="w-full max-w-md space-y-8">

                    <div className="text-center">
                        <div className="inline-flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900 font-heading">
                            <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center shadow-sm">
                                <BarChart3 className="text-white h-5 w-5" />
                            </div>
                            Consultancy<span className="text-teal-600">Dev</span>
                        </div>
                        <h2 className="mt-6 text-2xl font-bold tracking-tight text-slate-900 font-heading">
                            Sign in to your account
                        </h2>
                        {SHOW_PUBLIC_SIGNUP ? (
                            <p className="mt-2 text-sm text-slate-600 font-body">
                                Don&apos;t have an account?{' '}
                                <Link href="/signup" className="font-medium text-teal-600 hover:text-teal-500 transition-colors">
                                    Sign up here
                                </Link>
                            </p>
                        ) : (
                            <p className="mt-2 text-sm text-slate-500 font-body">
                                Use the credentials your administrator gave you.
                            </p>
                        )}
                    </div>

                    <Card className="border-slate-200 shadow-xl bg-white">
                        <CardContent className="pt-8 px-8 pb-8">
                            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                                {reasonMessage && !localError && !authError && (
                                    <div
                                        role="status"
                                        className={`flex items-start gap-2 rounded-lg border p-4 text-sm ${
                                            reasonIsInformational
                                                ? 'border-blue-200 bg-blue-50 text-blue-800'
                                                : 'border-amber-200 bg-amber-50 text-amber-800'
                                        }`}
                                    >
                                        <Info size={18} className="mt-0.5 shrink-0" />
                                        <p>{reasonMessage}</p>
                                    </div>
                                )}
                                {(localError || authError) && (
                                    <div className="flex items-center gap-2 p-4 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg">
                                        <AlertCircle size={18} />
                                        <p>{localError || authError}</p>
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <Label htmlFor="username" className="text-slate-700 font-medium font-body">Username or Email</Label>
                                    <Input
                                        id="username"
                                        type="text"
                                        placeholder="dev_admin or email@example.com"
                                        {...register('username')}
                                        disabled={isLoading}
                                        className="h-11 border-slate-300 focus:border-teal-500 focus:ring-teal-500"
                                    />
                                    {errors.username && (
                                        <p className="text-sm text-red-600 font-body">{errors.username.message}</p>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="password" className="text-slate-700 font-medium font-body">Password</Label>
                                    <Input
                                        id="password"
                                        type="password"
                                        {...register('password')}
                                        disabled={isLoading}
                                        className="h-11 border-slate-300 focus:border-teal-500 focus:ring-teal-500"
                                    />
                                    {errors.password && (
                                        <p className="text-sm text-red-600 font-body">{errors.password.message}</p>
                                    )}
                                </div>



                                <Button type="submit" className="w-full h-11 font-bold bg-teal-600 hover:bg-teal-700 text-white shadow-md transition-all hover:translate-y-px font-body" disabled={isLoading}>
                                    {isLoading ? 'Signing in...' : 'Sign in'}
                                </Button>
                            </form>

                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    // useSearchParams needs a Suspense boundary to keep this route static.
    return (
        <Suspense fallback={null}>
            <LoginForm />
        </Suspense>
    );
}

