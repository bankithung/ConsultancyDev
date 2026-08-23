'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/lib/apiClient';
import { getApiFieldErrors } from '@/lib/api';
import { Drawer } from '@/components/common/Drawer';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Branch } from '@/lib/types';

export interface BranchForm {
  name: string;
  code: string;
  city: string;
  address: string;
  phone: string;
  is_active: boolean;
}

const EMPTY_FORM: BranchForm = {
  name: '',
  code: '',
  city: '',
  address: '',
  phone: '',
  is_active: true,
};

/** The form values a branch starts an edit with, so "dirty" has a baseline. */
function formFor(branch: Branch | null): BranchForm {
  if (!branch) return EMPTY_FORM;
  return {
    name: branch.name,
    code: branch.code,
    city: branch.city,
    address: branch.address,
    phone: branch.phone,
    is_active: branch.is_active,
  };
}

interface BranchFormDrawerProps {
  open: boolean;
  /** The branch being edited, or null to create one. */
  branch: Branch | null;
  onClose: () => void;
}

/**
 * Add or edit a branch, in the app's shared right-edge drawer.
 *
 * This was a `Modal`; eight other forms in this app are drawers, and this is
 * now the ninth. The move is not only cosmetic — a drawer's scrim covers the
 * whole viewport, so a stray click is a far easier accident than a modal
 * backdrop miss. `requestClose` below vetoes the dismiss while there is typed
 * work and asks instead.
 *
 * ANIMATION is the primitive's, driven by plain CSS on Radix's `data-state`
 * (the `drawer` banner in app/globals.css). Nothing here animates, and nothing
 * here should: this project has no Tailwind animation plugin, so
 * `animate-in`/`slide-in-from-right` would compile to nothing, and a
 * hand-rolled mount/unmount would lose the exit that Radix's `Presence` keeps
 * alive by waiting on `animationend`.
 */
export function BranchFormDrawer({ open, branch, onClose }: BranchFormDrawerProps) {
  const queryClient = useQueryClient();

  const [form, setForm] = useState<BranchForm>(() => formFor(branch));
  /** What the form was opened with; the yardstick for "dirty". */
  const baseline = formFor(branch);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (payload: BranchForm) =>
      branch ? apiClient.branches.update(branch.id, payload) : apiClient.branches.create(payload),
    onSuccess: () => {
      // Both keys matter: `branches` is this list, `branch-options` is the
      // picker every other screen fills its branch dropdown from.
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      queryClient.invalidateQueries({ queryKey: ['branch-options'] });
      onClose();
    },
    onError: (error: unknown) => setFieldErrors(getApiFieldErrors(error) ?? {}),
  });

  /*
   * There is no reset path here on purpose. The page remounts this component
   * with a fresh `key` every time the drawer is opened, so each session starts
   * from these initialisers — no effect that would flash the previous branch's
   * name into the fields, and no render-phase `saveMutation.reset()`, which
   * would be a write to react-query's store from inside a render.
   */

  const isDirty = (Object.keys(baseline) as (keyof BranchForm)[]).some(
    (key) => form[key] !== baseline[key],
  );

  /**
   * Vetoes the scrim, Escape and the close button while there is unsaved
   * input. A half-typed branch vanishing on a misplaced click is the failure
   * this exists to prevent.
   */
  const requestClose = (): boolean => {
    // Mid-submit the branch may already be on its way; closing would leave the
    // user unsure whether it was created.
    if (saveMutation.isPending) return false;
    if (!isDirty || confirmDiscard) return true;
    setConfirmDiscard(true);
    return false;
  };

  const set = <K extends keyof BranchForm>(key: K, value: BranchForm[K]) =>
    setForm((live) => ({ ...live, [key]: value }));

  const footer = confirmDiscard ? (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium text-slate-700">
        Discard this branch? What you have entered will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 flex-1 sm:flex-none"
          onClick={() => setConfirmDiscard(false)}
        >
          Keep editing
        </Button>
        <Button
          type="button"
          className="h-9 flex-1 bg-rose-600 hover:bg-rose-700 sm:flex-none"
          onClick={onClose}
        >
          Discard
        </Button>
      </div>
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        type="button"
        variant="outline"
        className="h-9 w-full sm:w-auto"
        disabled={saveMutation.isPending}
        onClick={() => {
          if (requestClose()) onClose();
        }}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form="branch-form"
        className="h-9 w-full bg-teal-600 hover:bg-teal-700 sm:w-auto"
        disabled={saveMutation.isPending}
      >
        {saveMutation.isPending ? (
          <>
            <InlineSpinner className="mr-2" /> Saving…
          </>
        ) : branch ? (
          'Save changes'
        ) : (
          'Create branch'
        )}
      </Button>
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onRequestClose={requestClose}
      title={branch ? `Edit ${branch.name}` : 'New branch'}
      description={
        branch
          ? 'Update this office’s details.'
          : 'Managers and employees are assigned from the Users page once the branch exists.'
      }
      /*
        60% of the viewport from `md` up, full width below it — the same
        breakpoint the refund drawer uses, because at 640px a 60% panel is
        384px, narrower than the form's own fields.
      */
      panelClassName="md:w-[60vw]"
      bodyClassName="px-4 py-5 sm:px-6"
      footer={footer}
    >
      <form
        id="branch-form"
        className="mx-auto w-full max-w-2xl space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setFieldErrors({});
          saveMutation.mutate(form);
        }}
      >
        {saveMutation.isError && (
          <ErrorBanner error={saveMutation.error} onDismiss={() => saveMutation.reset()} />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="branch-name">
              Branch name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="branch-name"
              required
              className="h-10"
              value={form.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="Kochi Main"
            />
            {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch-code">
              Code <span className="text-red-500">*</span>
            </Label>
            <Input
              id="branch-code"
              required
              className="h-10 uppercase"
              value={form.code}
              onChange={(event) => set('code', event.target.value.toUpperCase())}
              placeholder="KCH"
            />
            {fieldErrors.code && <p className="text-xs text-red-600">{fieldErrors.code}</p>}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="branch-city">City</Label>
            <Input
              id="branch-city"
              className="h-10"
              value={form.city}
              onChange={(event) => set('city', event.target.value)}
            />
            {fieldErrors.city && <p className="text-xs text-red-600">{fieldErrors.city}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branch-phone">Phone</Label>
            <Input
              id="branch-phone"
              type="tel"
              className="h-10"
              value={form.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
            {fieldErrors.phone && <p className="text-xs text-red-600">{fieldErrors.phone}</p>}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="branch-address">Address</Label>
          <Textarea
            id="branch-address"
            rows={3}
            value={form.address}
            onChange={(event) => set('address', event.target.value)}
          />
          {fieldErrors.address && <p className="text-xs text-red-600">{fieldErrors.address}</p>}
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            checked={form.is_active}
            onChange={(event) => set('is_active', event.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-slate-900">Active</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Inactive branches stay in reports but cannot receive new records or staff.
            </span>
          </span>
        </label>
        {fieldErrors.is_active && <p className="text-xs text-red-600">{fieldErrors.is_active}</p>}
      </form>
    </Drawer>
  );
}
