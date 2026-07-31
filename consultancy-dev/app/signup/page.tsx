'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Building2, CheckCircle, BarChart3, ArrowLeft, ArrowRight, ShieldCheck, Zap, Users, Check, Mail, Phone, User, Lock, AlertCircle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { cn } from '@/lib/utils';

const companySignupSchema = z.object({
  company_name: z.string().min(2, 'Company name must be at least 2 characters'),
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
  username: z.string().min(3, 'Username must be at least 3 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
  phone: z.string().min(10, 'Valid phone number required'),
  plan: z.string().default('Medium')
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type CompanySignupFormData = z.infer<typeof companySignupSchema>;

const PLANS = [
  { id: 'Small', name: 'Starter', price: '₹3,999', period: '/mo', desc: 'For small agencies', icon: ShieldCheck, features: ['Up to 50 students', 'Email support'] },
  { id: 'Medium', name: 'Growth', price: '₹4,999', period: '/mo', desc: 'For growing teams', popular: true, icon: Zap, features: ['Up to 200 students', 'Priority support'] },
  { id: 'Large', name: 'Enterprise', price: '₹5,999', period: '/mo', desc: 'For large agencies', icon: Users, features: ['Unlimited students', '24/7 support'] }
];

const STEPS = [
  { id: 1, title: 'Company', icon: Building2, fields: ['company_name', 'phone', 'email'] },
  { id: 2, title: 'Account', icon: User, fields: ['first_name', 'last_name', 'username', 'password', 'confirmPassword'] },
  { id: 3, title: 'Plan', icon: Zap, fields: ['plan'] }
];

export default function CompanyAdminSignup() {
  const router = useRouter();
  const { signup, isLoading, error, clearError } = useAuthStore();
  const [success, setSuccess] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);

  const { register, handleSubmit, watch, trigger, formState: { errors } } = useForm<CompanySignupFormData>({
    resolver: zodResolver(companySignupSchema) as any,
    defaultValues: { plan: 'Medium' },
    mode: 'onChange'
  });

  const selectedPlan = watch('plan');

  const onSubmit = async (data: CompanySignupFormData) => {
    clearError();
    try {
      const { confirmPassword, ...signupData } = data;
      await signup({
        ...signupData,
        role: 'COMPANY_ADMIN',
        admin_name: `${data.first_name} ${data.last_name}`
      });
      setSuccess(true);
    } catch (err) {
      console.error('Signup failed:', err);
    }
  };

  const handleNext = async () => {
    const currentStepFields = STEPS.find(s => s.id === currentStep)?.fields || [];
    const isValid = await trigger(currentStepFields as any);
    if (isValid) {
      setCurrentStep((prev) => Math.min(prev + 1, STEPS.length));
    }
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 1));
  };

  if (success) {
    return (
      <div className="min-h-screen w-full flex bg-gradient-to-br from-slate-50 to-teal-50/30 items-center justify-center p-4">
        <div className="bg-white w-full max-w-lg p-10 rounded-3xl shadow-2xl text-center space-y-6 animate-in zoom-in-95 duration-300 border border-slate-100">
          <div className="mx-auto w-20 h-20 bg-gradient-to-br from-green-400 to-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-green-200">
            <CheckCircle className="w-10 h-10 text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">You're All Set!</h2>
            <p className="text-slate-500 mt-2">Your account request has been submitted for review.</p>
          </div>
          <Button onClick={() => router.push('/')} className="w-full h-12 text-base font-semibold bg-teal-600 text-white hover:bg-teal-700 rounded-xl shadow-lg shadow-teal-100">
            Back to Login
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex bg-white overflow-hidden font-sans">
      <style jsx global>{`
        @keyframes wave-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes wave-float-alt { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(15px); } }
        .anim-wave-1 { animation: wave-float 6s ease-in-out infinite; }
        .anim-wave-2 { animation: wave-float-alt 8s ease-in-out infinite; }
      `}</style>

      {/* Left Side - Visual */}
      <div className="hidden lg:flex w-[55%] bg-slate-900 text-white flex-col justify-between p-12 relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80')] bg-cover bg-center opacity-20"></div>
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-900/95 to-teal-900/40"></div>

        {/* Animated Wave Partition */}
        <div className="absolute top-[-10%] right-[-1px] bottom-[-10%] w-[120px] pointer-events-none z-20 h-[120%]">
          <svg className="absolute top-0 right-0 h-full w-full text-teal-800/30 fill-current anim-wave-2" viewBox="0 0 100 800" preserveAspectRatio="none"><path d="M50 0 C 130 200, 10 400, 80 800 L 100 800 L 100 0 Z" /></svg>
          <svg className="absolute top-0 right-0 h-full w-full text-slate-50 fill-current anim-wave-1" viewBox="0 0 100 800" preserveAspectRatio="none"><path d="M60 0 C 110 250, 20 550, 70 800 L 100 800 L 100 0 Z" /></svg>
        </div>

        {/* Logo Area - Top */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 bg-teal-500 rounded-xl flex items-center justify-center shadow-lg shadow-teal-500/20">
            <BarChart3 className="text-white h-6 w-6" />
          </div>
          <span className="text-2xl font-bold tracking-tight">Consultancy<span className="text-teal-400">Dev</span></span>
        </div>

        {/* Quote / Value Prop - Middle */}
        <div className="relative z-10 max-w-lg">
          <blockquote className="space-y-6">
            <div className="text-3xl font-medium leading-tight text-slate-100">
              "Streamline your entire consultancy workflow with the most advanced management platform built for education."
            </div>
            <footer className="flex items-center gap-4 pt-4">
              <div className="text-sm font-medium text-slate-400 italic">
                "Yet to be trusted"
              </div>
            </footer>
          </blockquote>
        </div>

        {/* Footer - Bottom */}
        <div className="relative z-10 text-xs text-slate-400">
          © 2026 ConsultancyDev Inc. Developed and managed in Nagaland.
        </div>
      </div>

      {/* Right Side - Form */}
      <div className="flex-1 lg:flex-none lg:w-[45%] h-full bg-gradient-to-br from-slate-50 to-teal-50/20 relative z-30 flex flex-col items-center justify-center p-6 lg:p-10">
        <div className="w-full max-w-lg mx-auto">

          {/* Step Indicator - Redesigned */}
          <div className="flex items-center justify-center gap-2 mb-8">
            {STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center">
                <div className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300",
                  currentStep === step.id ? "bg-teal-600 text-white shadow-lg shadow-teal-200" :
                    currentStep > step.id ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-400"
                )}>
                  <div className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                    currentStep === step.id ? "bg-white/20" :
                      currentStep > step.id ? "bg-teal-500 text-white" : "bg-slate-200"
                  )}>
                    {currentStep > step.id ? <Check size={12} /> : step.id}
                  </div>
                  <span className="text-xs font-semibold hidden sm:block">{step.title}</span>
                </div>
                {i < STEPS.length - 1 && <div className={cn("w-8 h-0.5 mx-1", currentStep > step.id ? "bg-teal-400" : "bg-slate-200")} />}
              </div>
            ))}
          </div>

          {/* Form Card */}
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200/60 p-8">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-slate-900 tracking-tight">{STEPS[currentStep - 1].title} Details</h2>
              <p className="text-slate-400 text-sm">Step {currentStep} of {STEPS.length}</p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              {error && (
                <div className="bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-3 text-sm animate-in fade-in">
                  <AlertCircle size={18} className="shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Step 1: Company */}
              {currentStep === 1 && (
                <div className="space-y-5 animate-in fade-in slide-in-from-right-5 duration-300">
                  <div>
                    <Label htmlFor="company_name" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <Building2 size={14} className="text-slate-400" /> Company Name
                    </Label>
                    <Input id="company_name" placeholder="Acme Education Pvt Ltd" {...register('company_name')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.company_name && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.company_name.message}</p>}
                  </div>
                  <div>
                    <Label htmlFor="phone" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <Phone size={14} className="text-slate-400" /> Official Phone
                    </Label>
                    <Input id="phone" placeholder="+91 98765 43210" {...register('phone')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.phone && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.phone.message}</p>}
                  </div>
                  <div>
                    <Label htmlFor="email" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <Mail size={14} className="text-slate-400" /> Official Email
                    </Label>
                    <Input id="email" type="email" placeholder="contact@acme.com" {...register('email')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.email && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.email.message}</p>}
                  </div>
                </div>
              )}

              {/* Step 2: Admin */}
              {currentStep === 2 && (
                <div className="space-y-5 animate-in fade-in slide-in-from-right-5 duration-300">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="first_name" className="text-sm font-medium text-slate-700 mb-1.5">First Name</Label>
                      <Input id="first_name" placeholder="John" {...register('first_name')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    </div>
                    <div>
                      <Label htmlFor="last_name" className="text-sm font-medium text-slate-700 mb-1.5">Last Name</Label>
                      <Input id="last_name" placeholder="Doe" {...register('last_name')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="username" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <User size={14} className="text-slate-400" /> Username
                    </Label>
                    <Input id="username" placeholder="johndoe_admin" {...register('username')} className="h-12 text-base rounded-xl bg-slate-50 border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.username && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.username.message}</p>}
                  </div>
                  <div>
                    <Label htmlFor="password" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <Lock size={14} className="text-slate-400" /> Password
                    </Label>
                    <Input id="password" type="password" placeholder="••••••••" {...register('password')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.password && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.password.message}</p>}
                  </div>
                  <div>
                    <Label htmlFor="confirmPassword" className="text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-2">
                      <Lock size={14} className="text-slate-400" /> Confirm Password
                    </Label>
                    <Input id="confirmPassword" type="password" placeholder="••••••••" {...register('confirmPassword')} className="h-12 text-base rounded-xl border-slate-200 focus:border-teal-500 focus:ring-teal-500/20" />
                    {errors.confirmPassword && <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1"><AlertCircle size={12} />{errors.confirmPassword.message}</p>}
                  </div>
                </div>
              )}

              {/* Step 3: Plan */}
              {currentStep === 3 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-5 duration-300">
                  <div className="grid grid-cols-3 gap-4">
                    {PLANS.map((plan) => (
                      <label key={plan.id} className="relative group cursor-pointer">
                        <input type="radio" value={plan.id} {...register('plan')} className="peer sr-only" />
                        <div className={cn(
                          "h-full p-5 rounded-2xl border-2 transition-all duration-200 flex flex-col items-center text-center bg-white hover:shadow-lg",
                          plan.id === selectedPlan ? "border-teal-500 shadow-lg shadow-teal-100" : "border-slate-200 hover:border-slate-300"
                        )}>
                          {plan.popular && <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-teal-500 to-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase shadow-md">Popular</span>}
                          <div className={cn(
                            "w-12 h-12 rounded-xl flex items-center justify-center mb-3 transition-colors",
                            plan.id === selectedPlan ? "bg-teal-100 text-teal-600" : "bg-slate-100 text-slate-400"
                          )}>
                            <plan.icon size={24} />
                          </div>
                          <h4 className="font-bold text-base text-slate-900">{plan.name}</h4>
                          <p className="text-[10px] text-slate-400 mb-2">{plan.desc}</p>
                          <p className="text-xl font-bold text-slate-800">{plan.price}<span className="text-xs font-normal text-slate-400">{plan.period}</span></p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Navigation Buttons */}
              <div className="flex items-center gap-3 pt-4">
                {currentStep > 1 && (
                  <Button type="button" variant="outline" onClick={handleBack} className="flex-1 h-12 rounded-xl border-slate-200 hover:bg-slate-50 font-semibold">
                    <ArrowLeft size={16} className="mr-2" /> Back
                  </Button>
                )}
                {currentStep < STEPS.length ? (
                  <Button type="button" onClick={handleNext} className="flex-1 h-12 bg-teal-600 hover:bg-teal-700 text-white rounded-xl font-semibold shadow-lg shadow-teal-100 transition-all hover:shadow-xl hover:shadow-teal-200">
                    Next <ArrowRight size={16} className="ml-2" />
                  </Button>
                ) : (
                  <Button type="submit" className="flex-1 h-12 bg-teal-600 hover:bg-teal-700 text-white rounded-xl font-semibold shadow-lg shadow-teal-100 transition-all hover:shadow-xl hover:shadow-teal-200" disabled={isLoading}>
                    {isLoading ? 'Creating...' : 'Create Workspace'}
                  </Button>
                )}
              </div>
            </form>

            <p className="text-center mt-6 text-xs text-slate-400">
              By continuing, you agree to our <Link href="#" className="text-teal-600 hover:underline">Terms</Link> and <Link href="#" className="text-teal-600 hover:underline">Privacy Policy</Link>.
            </p>
            <p className="text-center mt-4 text-sm text-slate-500">
              Already have an account? <Link href="/" className="text-teal-600 font-semibold hover:underline">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
