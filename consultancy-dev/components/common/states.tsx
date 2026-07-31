'use client';

import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getApiErrorMessage } from '@/lib/api';

/** Resolves either a raw error object or an already-extracted message. */
function toMessage(error: unknown): string {
  return typeof error === 'string' ? error : getApiErrorMessage(error);
}

/** Skeleton rows sized for a table or card list. */
export function LoadingState({ rows = 4, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-16 animate-pulse rounded-lg bg-slate-100" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Compact inline spinner for buttons and toolbars. */
export function InlineSpinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em] ${className}`}
      role="status"
      aria-hidden="true"
    />
  );
}

interface ErrorStateProps {
  /** An axios error, or a message string from `usePaginatedQuery`. */
  error: unknown;
  onRetry?: () => void;
  title?: string;
}

export function ErrorState({ error, onRetry, title = 'Could not load this data' }: ErrorStateProps) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
          <AlertCircle className="h-5 w-5 text-red-600" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-red-900">{title}</h3>
          <p className="mt-1 break-words text-sm text-red-700">{toMessage(error)}</p>
        </div>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="h-9 shrink-0 border-red-300 bg-white text-red-700 hover:bg-red-100"
          >
            <RefreshCw size={14} className="mr-2" /> Retry
          </Button>
        )}
      </div>
    </div>
  );
}

/** Non-blocking banner for a failed mutation. */
export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{toMessage(error)}</p>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs font-semibold text-red-600 underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Confirmation banner shown after a successful mutation. */
export function SuccessBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700">
      <p className="min-w-0 flex-1 break-words">{message}</p>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs font-semibold text-green-700 underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <Icon className="h-6 w-6 text-slate-400" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
