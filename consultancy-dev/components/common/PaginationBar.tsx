'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaginationProps {
  page: number;
  pages: number;
  count: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Disables the controls while a fetch is in flight. */
  isLoading?: boolean;
}

export function PaginationBar({ page, pages, count, pageSize, onPageChange, isLoading = false }: PaginationProps) {
  if (count === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, count);

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-200 px-3 py-3 sm:flex-row sm:px-4">
      <p className="text-xs text-slate-600 sm:text-sm">
        Showing <span className="font-semibold text-slate-900">{first}</span>–
        <span className="font-semibold text-slate-900">{last}</span> of{' '}
        <span className="font-semibold text-slate-900">{count}</span>
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1 || isLoading}
        >
          <ChevronLeft size={16} className="sm:mr-1" />
          <span className="hidden sm:inline">Previous</span>
        </Button>
        <span className="whitespace-nowrap px-1 text-xs text-slate-600 sm:text-sm">
          Page {page} of {Math.max(pages, 1)}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages || isLoading}
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight size={16} className="sm:ml-1" />
        </Button>
      </div>
    </div>
  );
}
