'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/lib/apiClient';
import type { UniversityInput } from '@/lib/types';
import { Drawer } from '@/components/common/Drawer';
import { ErrorBanner } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCurrentRole } from '@/components/rbac/useCurrentRole';
import { toast } from '@/store/toastStore';

const COUNTRIES = [
  'Russia', 'Czech Republic', 'Poland', 'Ukraine', 'Philippines', 'China',
  'Bangladesh', 'Nepal', 'Kyrgyzstan', 'Kazakhstan', 'USA', 'UK', 'Canada',
  'Australia', 'Germany', 'India',
] as const;

const PROGRAM_OPTIONS = [
  'MBBS', 'MD', 'BDS', 'BAMS', 'BHMS', 'Engineering', 'B.Tech', 'MBA', 'BBA',
  'Law', 'LLB', 'Nursing', 'Pharmacy', 'B.Sc', 'M.Sc', 'Arts', 'Commerce',
  'Management',
] as const;

const REQUIREMENT_OPTIONS = [
  'NEET Qualified', '60% in PCB', '50% in PCB', '12th Pass', 'IELTS 6.0+',
  'TOEFL 80+', 'Age 17-25', 'English Proficiency', 'Medical Fitness',
  'Valid Passport',
] as const;

/** `rating` is Decimal(max_digits=3, decimal_places=2) — 9.99 is the ceiling. */
const RATINGS = ['5.0', '4.8', '4.5', '4.3', '4.0', '3.8', '3.5', '3.0'] as const;

/**
 * Column counts for the checkbox grids.
 *
 * These have to STEP BACK at `md`, which looks wrong until you remember the
 * panel is a fraction of the viewport, not the viewport: below `md` it is
 * full-bleed, and at exactly `md` it snaps to 60vw — from 768px wide down to
 * 461px. A grid that keeps climbing through that boundary (the centred modal's
 * `sm:3 lg:4`) lands four ~140px columns in a 461px panel. Widening again at
 * `lg`/`xl` is safe because 60vw has by then overtaken the old full width.
 */
const CHECKBOX_GRID = 'grid-cols-2 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

interface FormState {
  name: string;
  country: string;
  city: string;
  ranking: string;
  rating: string;
  deadline: string;
  tuitionMin: string;
  tuitionMax: string;
  programs: string[];
  requirements: string[];
}

const EMPTY_FORM: FormState = {
  name: '',
  country: '',
  city: '',
  ranking: '',
  rating: '',
  deadline: '',
  tuitionMin: '',
  tuitionMax: '',
  programs: [],
  requirements: [],
};

interface AddUniversityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * Creates a catalogue entry via `POST universities/`.
 *
 * The old build posted `company_id` and a nested `tuitionFee: {min, max}`
 * object. Neither exists on `UniversitySerializer`: `company` is read-only and
 * stamped from the request user, and the fees are two flat decimal columns
 * (`tuition_fee_min` / `tuition_fee_max`), so every fee the old form collected
 * was silently discarded. There is also no `courses` field — the list is
 * `programs`.
 *
 * PANEL, NOT DIALOG: a right-edge drawer, matching every other create form in
 * the app. The name is kept because it is this component's public API.
 *
 * The three tabs the centred modal used are gone, replaced by three sections in
 * one scroll. A drawer is tall and narrow, so vertical scrolling is the axis it
 * already has; tabs additionally broke validation here, because the offending
 * field could be on a hidden tab — which is why the old `handleCreate` had to
 * drive `setActiveTab` before it could show an error. Sections keep the banner
 * and the field it refers to on screen together.
 */
export function AddUniversityModal({ isOpen, onClose, onSuccess }: AddUniversityModalProps) {
  const queryClient = useQueryClient();
  const { is } = useCurrentRole();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Mirrors the backend's `ReadOnlyOrManager` on UniversityViewSet: everyone
  // reads, only these four write. EMPLOYEE would get a 403.
  const canCreate = is('DEV_ADMIN', 'COMPANY_ADMIN', 'HEAD_MANAGER', 'BRANCH_MANAGER');

  // Reset during render rather than in an effect: an effect runs after paint,
  // so the previously submitted university would flash for a frame.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setForm(EMPTY_FORM);
      setValidationError(null);
      setConfirmDiscard(false);
    }
  }

  const createMutation = useMutation({
    mutationFn: (input: UniversityInput) => apiClient.universities.create(input),
    onSuccess: (university) => {
      queryClient.invalidateQueries({ queryKey: ['universities'] });
      toast.success('University added', `${university.name} is now in the catalogue.`);
      onSuccess?.();
      onClose();
    },
  });

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setValidationError(null);
  };

  /** Every field starts empty, so "not empty" is the whole dirty test. */
  const isDirty =
    form.name.trim() !== '' ||
    form.country !== '' ||
    form.city.trim() !== '' ||
    form.ranking !== '' ||
    form.rating !== '' ||
    form.deadline !== '' ||
    form.tuitionMin !== '' ||
    form.tuitionMax !== '' ||
    form.programs.length > 0 ||
    form.requirements.length > 0;

  /**
   * Vetoes scrim clicks, Escape and the close button while there is unsaved
   * input, and asks instead. This form is long enough that losing it to a
   * misplaced click costs real work.
   */
  const requestClose = (): boolean => {
    // Mid-submit the record may already be on its way to the server.
    if (createMutation.isPending) return false;
    if (!isDirty || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.name.trim() || !form.country) {
      setValidationError('Name and country are required.');
      return;
    }

    const min = Number(form.tuitionMin) || 0;
    const max = Number(form.tuitionMax) || 0;
    if (max > 0 && min > max) {
      setValidationError('Maximum tuition cannot be lower than the minimum.');
      return;
    }

    createMutation.mutate({
      name: form.name.trim(),
      country: form.country,
      city: form.city.trim(),
      // PositiveIntegerField(null=True). Blank means "unranked" — sending 0
      // would claim the university is ranked #0.
      ranking: form.ranking ? Number(form.ranking) : null,
      rating: form.rating ? Number(form.rating) : 0,
      programs: form.programs,
      requirements: form.requirements,
      tuition_fee_min: min,
      tuition_fee_max: max,
      // CharField(max_length=50), not a DateField — the ISO string is fine.
      admission_deadline: form.deadline,
    });
  };

  if (!canCreate) {
    return (
      <Drawer
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title="Add university"
        panelClassName="md:w-[60vw]"
        bodyClassName="px-4 py-5 sm:px-6"
      >
        <p className="py-6 text-center text-sm text-slate-600">
          Only managers and administrators can add to the university catalogue.
        </p>
      </Drawer>
    );
  }

  const footer = confirmDiscard ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard this university? What you have entered will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setConfirmDiscard(false)}
          className="flex-1 sm:flex-none"
        >
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={onClose}
          className="flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none"
        >
          Discard
        </Button>
      </div>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-3xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          if (requestClose()) onClose();
        }}
        disabled={createMutation.isPending}
        className="w-full sm:w-auto"
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="add-university-form"
        disabled={createMutation.isPending}
        className="w-full sm:w-auto"
      >
        {createMutation.isPending ? 'Creating…' : 'Create university'}
      </Button>
    </div>
  );

  return (
    <Drawer
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onRequestClose={requestClose}
      title="Add university"
      description="Add a university to the shared catalogue."
      /* 60% of the viewport from `md` up, full width below — the geometry every
         other drawer in the app uses. */
      panelClassName="md:w-[60vw]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={footer}
    >
      <form
        id="add-university-form"
        onSubmit={handleCreate}
        className="mx-auto w-full max-w-3xl space-y-8"
      >
        {validationError && <ErrorBanner error={validationError} />}
        {createMutation.isError && (
          <ErrorBanner error={createMutation.error} onDismiss={() => createMutation.reset()} />
        )}

        <section className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-900">Basic info</h3>

          {/* The name gets its own row: it is the one free-text field whose
              value is routinely long enough to need the full measure. */}
          <div className="space-y-2">
            <Label htmlFor="uni-name">
              University name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="uni-name"
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Enter university name"
            />
          </div>

          {/* Paired because they are one thought — where the university is. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="uni-country">
                Country <span className="text-red-500">*</span>
              </Label>
              <Select value={form.country} onValueChange={(value) => update('country', value)}>
                <SelectTrigger id="uni-country">
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {COUNTRIES.map((country) => (
                    <SelectItem key={country} value={country}>
                      {country}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="uni-city">City</Label>
              <Input
                id="uni-city"
                value={form.city}
                onChange={(event) => update('city', event.target.value)}
                placeholder="Enter city name"
              />
            </div>
          </div>

          {/* Both short, and both answer "how good is it" — paired. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="uni-ranking">World ranking</Label>
              <Input
                id="uni-ranking"
                type="number"
                min={1}
                value={form.ranking}
                onChange={(event) => update('ranking', event.target.value)}
                placeholder="150"
              />
              <p className="text-xs text-slate-500">Leave blank if unranked.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="uni-rating">Overall rating</Label>
              <Select value={form.rating} onValueChange={(value) => update('rating', value)}>
                <SelectTrigger id="uni-rating">
                  <SelectValue placeholder="Select rating" />
                </SelectTrigger>
                <SelectContent>
                  {RATINGS.map((rating) => (
                    <SelectItem key={rating} value={rating}>
                      {rating} / 5
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="uni-deadline">Application deadline</Label>
            <Input
              id="uni-deadline"
              type="date"
              value={form.deadline}
              onChange={(event) => update('deadline', event.target.value)}
            />
          </div>
        </section>

        <section className="space-y-5">
          <h3 className="text-sm font-semibold text-slate-900">Programs &amp; fees</h3>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-slate-700">Programs offered</legend>
            {/* No inner max-height here, unlike the modal: a scroll box nested
                in a scrolling panel traps the wheel, and the tall panel has the
                room to simply show all eighteen. */}
            <div className={`grid ${CHECKBOX_GRID} gap-1 rounded border border-slate-200 bg-slate-50 p-2`}>
              {PROGRAM_OPTIONS.map((program) => (
                <label
                  key={program}
                  className="flex cursor-pointer items-center gap-2 rounded p-2 transition-colors hover:bg-white"
                >
                  <input
                    type="checkbox"
                    checked={form.programs.includes(program)}
                    onChange={() => update('programs', toggle(form.programs, program))}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span className="text-sm leading-snug text-slate-700">{program}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">{form.programs.length} selected</p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-slate-700">Annual tuition (INR)</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="uni-fee-min">Minimum</Label>
                <Input
                  id="uni-fee-min"
                  type="number"
                  min={0}
                  value={form.tuitionMin}
                  onChange={(event) => update('tuitionMin', event.target.value)}
                  placeholder="250000"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="uni-fee-max">Maximum</Label>
                <Input
                  id="uni-fee-max"
                  type="number"
                  min={0}
                  value={form.tuitionMax}
                  onChange={(event) => update('tuitionMax', event.target.value)}
                  placeholder="500000"
                />
              </div>
            </div>
          </fieldset>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">Requirements</h3>
          <fieldset className="space-y-3">
            <legend className="sr-only">Eligibility requirements</legend>
            {/* Two columns at most: these labels are sentences, and wrapping one
                onto a second line beats the modal's `truncate`, which hid the
                difference between "60% in PCB" and "50% in PCB". */}
            <div className="grid grid-cols-1 gap-1 rounded border border-slate-200 bg-slate-50 p-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
              {REQUIREMENT_OPTIONS.map((requirement) => (
                <label
                  key={requirement}
                  className="flex cursor-pointer items-center gap-2 rounded p-2 transition-colors hover:bg-white"
                >
                  <input
                    type="checkbox"
                    checked={form.requirements.includes(requirement)}
                    onChange={() => update('requirements', toggle(form.requirements, requirement))}
                    className="h-4 w-4 shrink-0 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span className="text-sm leading-snug text-slate-700">{requirement}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500">{form.requirements.length} selected</p>
          </fieldset>
        </section>
      </form>
    </Drawer>
  );
}
