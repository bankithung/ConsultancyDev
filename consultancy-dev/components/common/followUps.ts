import type { AdmissionLikelihood, FollowUpInput, FollowUpOutcome } from '@/lib/types';

/**
 * Follow-up vocabulary as RUNTIME values.
 *
 * `lib/types.ts` now owns the `FollowUpOutcome` / `AdmissionLikelihood` unions,
 * the `outcome_status` and `admission_possibility` fields on `FollowUp` /
 * `FollowUpInput`, and the `FollowUpComment` row type. `apiClient.followUpComments`
 * owns the thread. All of that used to be duplicated here and has been removed --
 * a second copy of a wire vocabulary is how two spellings of the same value end
 * up in the codebase.
 *
 * What is left is the part a type union cannot give you: arrays to iterate when
 * rendering a picker, and human labels. Both are typed against lib's unions, so
 * dropping or misspelling a value fails to compile.
 */

/** `FollowUp.Outcome` -- what actually happened on the call. */
export const FOLLOW_UP_OUTCOMES: readonly FollowUpOutcome[] = [
  'Not reached',
  'Interested',
  'Thinking',
  'Not interested',
  'Converted',
];

/**
 * Human labels, from the second element of each TextChoices pair. Kept apart
 * from the wire values so a label can be reworded without breaking a filter.
 */
export const FOLLOW_UP_OUTCOME_LABELS: Record<FollowUpOutcome, string> = {
  'Not reached': 'Could not reach',
  Interested: 'Interested',
  Thinking: 'Still deciding',
  'Not interested': 'Not interested',
  Converted: 'Converted',
};

/**
 * `FollowUp.Likelihood` -- a four-value CharField(max_length=10), NOT a
 * percentage.
 *
 * The old build stored this as an integer 0-100 behind a slider. There is no
 * numeric column, so a percentage would be rejected or truncated to garbage.
 */
export const ADMISSION_LIKELIHOODS: readonly AdmissionLikelihood[] = [
  'High',
  'Medium',
  'Low',
  'Unknown',
];

/** Both fields are `blank=True, default=''`, so '' is a legitimate "not recorded". */
export type FollowUpOutcomeValue = FollowUpOutcome | '';
export type AdmissionLikelihoodValue = AdmissionLikelihood | '';

/**
 * The two outcome fields, taken straight off `FollowUpInput` so this cannot
 * drift from the write shape lib declares.
 */
export type FollowUpOutcomeInput = Pick<
  FollowUpInput,
  'outcome_status' | 'admission_possibility'
>;

/** Re-exported so a picker can import its values and its type from one place. */
export type { AdmissionLikelihood, FollowUpOutcome };
