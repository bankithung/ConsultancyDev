'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { VisaTracking } from '@/lib/types';
import { toast } from '@/store/toastStore';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plane, FileText, CheckCircle, Clock, AlertCircle, Plus, Search, X } from 'lucide-react';
import { format } from 'date-fns';
import * as Dialog from '@radix-ui/react-dialog';

import { toArray } from '@/components/common/pagination';

/**
 * Stage values MUST match the backend's VisaTracking.STAGE_CHOICES exactly.
 *
 * The page previously used its own labels ('Document Preparation',
 * 'Application Submitted', 'Under Review'), none of which the API recognises —
 * so the stage filter silently matched nothing and every new record was
 * created with an invalid stage. Value is what the server stores; label is
 * what the user reads.
 */
const VISA_STAGES: { value: string; label: string }[] = [
  { value: 'Documents', label: 'Document preparation' },
  { value: 'Applied', label: 'Application submitted' },
  { value: 'Biometrics', label: 'Biometrics' },
  { value: 'Interview', label: 'Interview' },
  { value: 'Decision', label: 'Awaiting decision' },
  { value: 'Approved', label: 'Approved' },
  { value: 'Rejected', label: 'Rejected' },
];

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  VISA_STAGES.map((s) => [s.value, s.label]),
);

export default function VisaTrackingPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedVisa, setSelectedVisa] = useState<VisaTracking | null>(null);

  // Form State
  const [studentName, setStudentName] = useState('');
  const [passportNo, setPassportNo] = useState('');
  const [country, setCountry] = useState('');
  const [visaType, setVisaType] = useState('Student Visa');
  const [appliedDate, setAppliedDate] = useState('');
  const [currentStage, setCurrentStage] = useState('Documents');
  const [notes, setNotes] = useState('');

  const queryClient = useQueryClient();

  const visaQuery = usePaginatedQuery<VisaTracking>(['visaTracking'], apiClient.visaTracking.list, {
    // The stage board groups every application, so load them in one page.
    pageSize: 200,
    ordering: '-applied_date',
  });
  const visaApplications = visaQuery.rows;
  const isLoading = visaQuery.isLoading;

  // Stage totals across every application in scope, computed server-side.
  const pipelineQuery = useQuery({
    queryKey: ['analytics', 'visa-pipeline'],
    queryFn: apiClient.analytics.getVisaPipeline,
    staleTime: 60_000,
  });

  const createVisaMutation = useMutation({
    mutationFn: apiClient.visaTracking.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['visaTracking'] });
      setIsCreateOpen(false);
      resetForm();
      toast.success('Visa application created');
    },
  });

  const resetForm = () => {
    setStudentName('');
    setPassportNo('');
    setCountry('');
    setVisaType('Student Visa');
    setAppliedDate('');
    setCurrentStage('Documents');
    setNotes('');
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createVisaMutation.mutate({
      studentName,
      passportNo,
      country,
      visaType,
      appliedDate,
      currentStage,
      status: 'In Progress',
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-slate-500">Loading visa applications...</div>
      </div>
    );
  }

  const filteredVisas = visaApplications.filter((visa: VisaTracking) => {
    const matchesSearch = visa.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      visa.passportNo.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStage = filterStage === 'all' || visa.currentStage === filterStage;
    return matchesSearch && matchesStage;
  });

  // Full-scope figures from the server; the board below shows the loaded page.
  const stageCounts = new Map((pipelineQuery.data?.pipeline ?? []).map((s) => [s.stage, s.count]));
  const approvedCount = stageCounts.get('Approved') ?? 0;
  const rejectedCount = stageCounts.get('Rejected') ?? 0;
  const totalTracked = pipelineQuery.data?.total ?? 0;
  const pendingCount = Math.max(totalTracked - approvedCount - rejectedCount, 0);
  const totalCompleted = approvedCount + rejectedCount;
  const successRate = totalCompleted > 0 ? Math.round((approvedCount / totalCompleted) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Visa Application Tracking</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Monitor visa application status and stages</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="h-9 bg-teal-600 hover:bg-teal-700 font-body">
          <Plus className="mr-2 h-4 w-4" /> Add Application
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-slate-200 bg-gradient-to-br from-yellow-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">In Progress</p>
                <h3 className="text-2xl font-bold text-yellow-600 font-heading">{pendingCount}</h3>
              </div>
              <Clock className="h-10 w-10 text-yellow-600" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-green-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Approved</p>
                <h3 className="text-2xl font-bold text-green-600 font-heading">{approvedCount}</h3>
              </div>
              <CheckCircle className="h-10 w-10 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 bg-gradient-to-br from-teal-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600 font-body">Success Rate</p>
                <h3 className="text-2xl font-bold text-teal-600 font-heading">{successRate}%</h3>
              </div>
              <Plane className="h-10 w-10 text-teal-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="border-slate-200 bg-slate-50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input placeholder="Search student or passport..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-10 bg-white" />
            </div>
            <Select value={filterStage} onValueChange={setFilterStage}>
              <SelectTrigger className="h-10 bg-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stages</SelectItem>
                {VISA_STAGES.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" className="h-10 font-body" onClick={() => { setFilterStage('all'); setSearchTerm(''); }}>
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Applications List */}
      <div className="space-y-4">
        {filteredVisas.map((visa: VisaTracking) => (
          <Card key={visa.id} className="border-slate-200 hover:shadow-md transition-shadow cursor-pointer" onClick={() => setSelectedVisa(visa)}>
            <CardContent className="p-6">
              <div className="flex flex-col lg:flex-row items-start justify-between gap-4">
                <div className="flex items-start gap-4 flex-1">
                  <div className="w-12 h-12 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 font-bold text-lg shrink-0">
                    {visa.studentName.charAt(0)}
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-bold text-slate-900 font-heading">{visa.studentName}</h3>
                    <p className="text-sm text-slate-600 font-body mt-1">{visa.visaType} - {visa.country}</p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 font-body">
                      <span>Passport: {visa.passportNo}</span>
                      <span>Applied: {format(new Date(visa.appliedDate), 'dd MMM yyyy')}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <span className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${visa.currentStage === 'Approved' ? 'bg-green-100 text-green-700' :
                    visa.currentStage === 'Rejected' ? 'bg-red-100 text-red-700' :
                      visa.currentStage === 'Interview Scheduled' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-blue-100 text-blue-700'
                    }`}>
                    {STAGE_LABELS[visa.currentStage] ?? visa.currentStage}
                  </span>
                  {visa.interviewDate && (
                    <p className="text-xs text-slate-600 font-body">Interview: {format(new Date(visa.interviewDate), 'dd MMM')}</p>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="mt-6">
                <div className="flex justify-between text-xs text-slate-600 mb-2 font-body">
                  {VISA_STAGES.slice(0, 5).map(({ value, label }, i) => {
                    const currentIndex = VISA_STAGES.findIndex((s) => s.value === visa.currentStage);
                    const isCompleted = i <= currentIndex;
                    return (
                      <span key={value} className={`${isCompleted ? 'text-teal-600 font-semibold' : ''}`}>
                        {label.split(' ')[0]}
                      </span>
                    );
                  })}
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-teal-600 rounded-full transition-all"
                    style={{ width: `${(Math.max(VISA_STAGES.findIndex((s) => s.value === visa.currentStage), 0) / (VISA_STAGES.length - 1)) * 100}%` }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Visa Modal */}
      <Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] w-[90vw] max-w-[600px] translate-x-[-50%] translate-y-[-50%] rounded-xl bg-white p-6 shadow-xl z-50 border max-h-[90vh] overflow-y-auto">
            <Dialog.Title className="text-xl font-bold text-slate-900 mb-6 font-heading">New Visa Application</Dialog.Title>
            <form className="space-y-4" onSubmit={handleCreate}>
              <div className="space-y-2">
                <Label className="font-body">Student Name</Label>
                <Input
                  className="h-11"
                  placeholder="e.g. John Doe"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-body">Passport No</Label>
                  <Input
                    className="h-11"
                    placeholder="e.g. A1234567"
                    value={passportNo}
                    onChange={(e) => setPassportNo(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-body">Country</Label>
                  <Input
                    className="h-11"
                    placeholder="e.g. USA"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-body">Visa Type</Label>
                  <Select value={visaType} onValueChange={setVisaType}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Student Visa">Student Visa</SelectItem>
                      <SelectItem value="Tourist Visa">Tourist Visa</SelectItem>
                      <SelectItem value="Work Visa">Work Visa</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="font-body">Applied Date</Label>
                  <Input
                    type="date"
                    className="h-11"
                    value={appliedDate}
                    onChange={(e) => setAppliedDate(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="font-body">Current Stage</Label>
                <Select value={currentStage} onValueChange={setCurrentStage}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VISA_STAGES.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-body">Notes</Label>
                <textarea
                  className="w-full min-h-[80px] px-3 py-2 border border-slate-300 rounded-md focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none font-body"
                  placeholder="Add any details..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="flex gap-3 pt-4">
                <Button variant="outline" type="button" onClick={() => setIsCreateOpen(false)} className="flex-1 h-11 font-body">Cancel</Button>
                <Button type="submit" className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 font-body" disabled={createVisaMutation.isPending}>
                  {createVisaMutation.isPending ? 'Creating...' : 'Create Application'}
                </Button>
              </div>
            </form>
            <Dialog.Close asChild>
              <button className="absolute top-4 right-4 p-1 rounded-full hover:bg-slate-100">
                <X size={20} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
