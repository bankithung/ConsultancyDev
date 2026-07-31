'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { MessageSquare, Plus, User } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import type { PageParams, StudentRemark } from '@/lib/types';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { PaginationBar } from '@/components/common/PaginationBar';
import { EmptyState, ErrorState, LoadingState, ErrorBanner, InlineSpinner } from '@/components/common/states';
import { toast } from '@/store/toastStore';

interface StudentRemarkListProps {
  registrationId: string;
}

/**
 * Running commentary on a student's file.
 *
 * Deliberately add-only: the API rejects PATCH on a remark, because a remark
 * records what was believed at the time. There is no edit or delete control,
 * and there should not be one.
 */
export function StudentRemarkList({ registrationId }: StudentRemarkListProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const fetchRemarks = useCallback(
    (params?: PageParams) => apiClient.studentRemarks.list(registrationId, params),
    [registrationId],
  );

  const remarks = usePaginatedQuery<StudentRemark>(['student-remarks', registrationId], fetchRemarks, {
    ordering: '-created_at',
    pageSize: 10,
    enabled: Boolean(registrationId),
  });

  const createMutation = useMutation({
    mutationFn: (remark: string) => apiClient.studentRemarks.create({ registration: registrationId, remark }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['student-remarks', registrationId] });
      setDraft('');
      setIsAdding(false);
      toast.success('Remark added');
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-700">
          <MessageSquare size={16} />
          Student remarks
        </h3>
        <Button
          size="sm"
          className="h-9"
          variant={isAdding ? 'ghost' : 'default'}
          onClick={() => setIsAdding((open) => !open)}
        >
          {isAdding ? (
            'Cancel'
          ) : (
            <>
              <Plus size={14} className="mr-1" /> Add remark
            </>
          )}
        </Button>
      </div>

      <p className="text-xs text-slate-500">
        Remarks are a permanent log — once saved they cannot be edited or removed.
      </p>

      {isAdding && (
        <Card className="border border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <form onSubmit={handleSubmit} className="space-y-3">
              <Textarea
                placeholder="What happened, and what did we agree?"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[100px]"
                aria-label="New remark"
              />
              {createMutation.isError && <ErrorBanner error={createMutation.error} />}
              <div className="flex justify-end">
                <Button type="submit" size="sm" className="h-9" disabled={createMutation.isPending || !draft.trim()}>
                  {createMutation.isPending ? (
                    <>
                      <InlineSpinner className="mr-2" /> Saving…
                    </>
                  ) : (
                    'Save remark'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {remarks.isLoading && <LoadingState rows={3} label="Loading remarks" />}

      {remarks.isError && <ErrorState error={remarks.error} onRetry={remarks.refetch} title="Could not load remarks" />}

      {!remarks.isLoading && !remarks.isError && remarks.isEmpty && (
        <EmptyState
          title="No remarks yet"
          description="Add the first note so the next person picking up this file knows where things stand."
          icon={MessageSquare}
        />
      )}

      {!remarks.isError && remarks.rows.length > 0 && (
        <>
          <ul className="space-y-3">
            {remarks.rows.map((remark) => (
              <li key={remark.id}>
                <Card className="border border-slate-100 bg-white shadow-sm">
                  <CardContent className="p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5">
                        <User size={10} />
                        <span className="font-medium">{remark.user_name || 'Unknown'}</span>
                      </span>
                      <span aria-hidden="true">•</span>
                      <time dateTime={remark.created_at}>
                        {format(new Date(remark.created_at), 'dd MMM yyyy, h:mm a')}
                      </time>
                      {remark.branch_name && (
                        <span className="rounded bg-slate-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                          {remark.branch_name}
                        </span>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-slate-700">{remark.remark}</p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>

          <PaginationBar
            page={remarks.page}
            pages={remarks.pages}
            count={remarks.count}
            pageSize={remarks.pageSize}
            onPageChange={remarks.setPage}
            isLoading={remarks.isFetching}
          />
        </>
      )}
    </div>
  );
}
