'use client';

import { useState } from 'react';
import { format } from 'date-fns';

import { Modal } from '@/components/common/Modal';
import {
  ADMISSION_LIKELIHOODS,
  FOLLOW_UP_OUTCOMES,
  FOLLOW_UP_OUTCOME_LABELS,
  type AdmissionLikelihood,
  type FollowUpOutcome,
  type FollowUpOutcomeInput,
} from '@/components/common/followUps';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import type { FollowUp, FollowUpInput } from '@/lib/types';

/**
 * Wire value written to `FollowUp.status` on completion.
 *
 * `status` is a free CharField (max_length=20) defaulting to 'Pending'; the
 * list views and `useUpcomingReminders` treat anything that is not 'Pending' as
 * off the queue, so this is the value that closes a follow-up.
 */
export const FOLLOW_UP_COMPLETED_STATUS = 'Completed';

/** Per-outcome styling, keyed by the WIRE value so a typo fails to compile. */
const OUTCOME_TONES: Record<FollowUpOutcome, string> = {
  Converted: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  Interested: 'border-blue-200 bg-blue-50 text-blue-900',
  Thinking: 'border-amber-200 bg-amber-50 text-amber-900',
  'Not reached': 'border-slate-200 bg-white text-slate-600',
  'Not interested': 'border-rose-200 bg-rose-50 text-rose-900',
};

const LIKELIHOOD_TONES: Record<AdmissionLikelihood, string> = {
  High: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  Medium: 'border-amber-200 bg-amber-50 text-amber-900',
  Low: 'border-rose-200 bg-rose-50 text-rose-900',
  Unknown: 'border-slate-200 bg-white text-slate-600',
};

/**
 * The patch to PATCH.
 *
 * Composed here so callers cannot get the vocabulary wrong — `status`,
 * `outcome_status` and `admission_possibility` are all `string` on the wire,
 * and TypeScript cannot catch a mismatch across that boundary.
 */
export type FollowUpCompletion = Pick<FollowUpInput, 'status' | 'completed_at' | 'notes'> &
  FollowUpOutcomeInput;

interface CompleteFollowUpModalProps {
  followUp: FollowUp | null;
  open: boolean;
  onClose: () => void;
  onComplete: (patch: FollowUpCompletion) => void;
  isLoading?: boolean;
}

/** Appends the completion note to whatever notes the follow-up already carries. */
function composeNotes(existing: string, comment: string): string {
  const stamp = format(new Date(), 'dd MMM yyyy, h:mm a');
  const block = `--- Completed ${stamp} ---\n${comment.trim()}`;
  return existing.trim() ? `${existing.trim()}\n\n${block}` : block;
}

export function CompleteFollowUpModal({
  followUp,
  open,
  onClose,
  onComplete,
  isLoading = false,
}: CompleteFollowUpModalProps) {
  const [comment, setComment] = useState('');
  const [outcome, setOutcome] = useState<FollowUpOutcome>('Interested');
  const [likelihood, setLikelihood] = useState<AdmissionLikelihood>('Unknown');
  const [showCommentError, setShowCommentError] = useState(false);

  // Reset during render rather than in an effect: an effect runs after paint,
  // so the last completion's notes would flash before being cleared.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setComment('');
      setOutcome('Interested');
      setLikelihood('Unknown');
      setShowCommentError(false);
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!followUp) return;

    if (!comment.trim()) {
      setShowCommentError(true);
      return;
    }

    onComplete({
      status: FOLLOW_UP_COMPLETED_STATUS,
      completed_at: new Date().toISOString(),
      notes: composeNotes(followUp.notes, comment),
      // Real columns now, so these are sent as themselves rather than folded
      // into the notes text as the first pass had to do.
      outcome_status: outcome,
      admission_possibility: likelihood,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Complete follow-up"
      description="Record what happened and how likely this student is to enrol."
      size="lg"
    >
      {!followUp ? (
        <p className="py-6 text-center text-sm text-slate-500">No follow-up selected.</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Student</p>
              <p className="truncate text-sm font-bold text-slate-800">{followUp.enquiry_candidate}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Interaction</p>
              <p className="truncate text-sm font-bold text-slate-800">{followUp.type}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Scheduled</p>
              <p className="truncate text-sm font-bold text-slate-800">
                {format(new Date(followUp.scheduled_for), 'dd MMM, h:mm a')}
              </p>
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
              Outcome
            </legend>
            <RadioGroup
              value={outcome}
              onValueChange={(value) => setOutcome(value as FollowUpOutcome)}
              disabled={isLoading}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {FOLLOW_UP_OUTCOMES.map((value) => (
                <div key={value}>
                  <RadioGroupItem value={value} id={`outcome-${value}`} className="peer sr-only" />
                  <Label
                    htmlFor={`outcome-${value}`}
                    className={`flex cursor-pointer items-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all hover:bg-slate-50 peer-data-[state=checked]:border-slate-900 peer-data-[state=checked]:ring-1 peer-data-[state=checked]:ring-slate-900 ${OUTCOME_TONES[value]}`}
                  >
                    {FOLLOW_UP_OUTCOME_LABELS[value]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
              Admission likelihood
            </legend>
            {/*
              Four options, not a 0-100 slider: `admission_possibility` is a
              CharField(max_length=10) with four choices, so a percentage has
              nowhere to go.
            */}
            <RadioGroup
              value={likelihood}
              onValueChange={(value) => setLikelihood(value as AdmissionLikelihood)}
              disabled={isLoading}
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {ADMISSION_LIKELIHOODS.map((value) => (
                <div key={value}>
                  <RadioGroupItem value={value} id={`likelihood-${value}`} className="peer sr-only" />
                  <Label
                    htmlFor={`likelihood-${value}`}
                    className={`flex cursor-pointer items-center justify-center rounded-lg border-2 px-3 py-2.5 text-xs font-semibold transition-all hover:bg-slate-50 peer-data-[state=checked]:border-slate-900 peer-data-[state=checked]:ring-1 peer-data-[state=checked]:ring-slate-900 ${LIKELIHOOD_TONES[value]}`}
                  >
                    {value}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>

          <div className="space-y-2">
            <Label
              htmlFor="completion-notes"
              className="text-[11px] font-bold uppercase tracking-widest text-slate-500"
            >
              Completion notes <span className="text-rose-500">*</span>
            </Label>
            <Textarea
              id="completion-notes"
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
                if (event.target.value.trim()) setShowCommentError(false);
              }}
              rows={4}
              placeholder="What was discussed, and what happens next?"
              disabled={isLoading}
              aria-invalid={showCommentError}
              aria-describedby={showCommentError ? 'completion-notes-error' : undefined}
            />
            {showCommentError && (
              <p id="completion-notes-error" className="text-sm text-rose-600">
                Add a note describing the outcome before completing.
              </p>
            )}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading} className="w-full sm:w-auto">
              {isLoading ? 'Saving…' : 'Mark complete'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
