import { api } from '@/lib/api';
import type { ApprovalRequest } from '@/lib/types';

export interface ApprovalRequestInput {
  action: ApprovalRequest['action'];
  entity_type: string;
  entity_id: number;
  entity_name: string;
  message: string;
  /** Proposed field values for an UPDATE request. Writable on the serializer. */
  pending_changes?: Record<string, unknown>;
}

/**
 * Raises an approval request.
 *
 * `apiClient.approvalRequests.create` does not accept `pending_changes` yet
 * (fe-infra has been asked to widen it), and an UPDATE request is meaningless
 * without the proposed values, so this posts directly for now.
 */
export async function createApprovalRequest(input: ApprovalRequestInput): Promise<ApprovalRequest> {
  const res = await api.post<ApprovalRequest>('approval-requests/', input);
  return res.data;
}
