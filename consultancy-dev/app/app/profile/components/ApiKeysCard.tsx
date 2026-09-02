'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/common/Modal';
import { ErrorBanner, InlineSpinner } from '@/components/common/states';
import { apiClient } from '@/lib/apiClient';
import { API_URL, getApiErrorMessage } from '@/lib/api';
import type { ApiKey, ApiKeyCreated } from '@/lib/types';
import { toast } from '@/store/toastStore';

/**
 * "AI access keys": mint, list and revoke personal API keys used by MCP
 * clients (Claude Desktop, Cursor, ChatGPT connectors...) to act as this user.
 *
 * The plaintext key exists only in the create response, so it is shown once in
 * a modal with a copy button and a ready-to-paste client config. Revoking is
 * immediate and irreversible, hence the confirm dialog.
 */

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

type KeyStatus = 'Active' | 'Expired' | 'Revoked';

/**
 * `is_valid` is the server's own verdict (not revoked AND not past expiry), so
 * it decides usability. It cannot say WHY a key is dead, which is what the
 * badge has to show: `revoked_at` separates a deliberate revocation from an
 * `expires_at` that simply passed.
 */
function keyStatus(key: ApiKey): KeyStatus {
  if (key.revoked_at) return 'Revoked';
  if (!key.is_valid) return 'Expired';
  return 'Active';
}

const STATUS_CLASS: Record<KeyStatus, string> = {
  Active: 'border-transparent bg-green-100 text-green-700 hover:bg-green-100',
  Expired: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100',
  Revoked: 'border-transparent bg-slate-100 text-slate-500 hover:bg-slate-100',
};

/**
 * The API base URL to advertise in the snippet.
 *
 * Deliberately NOT the `API_URL` constant: when `NEXT_PUBLIC_API_URL` is unset
 * that falls back to `http://127.0.0.1:8000/api/`, and pasting a localhost URL
 * into the config of someone using a deployed console hands them a client that
 * talks to their own machine. The browser's own origin is the better guess
 * there, since an unset var means the app is being served same-origin.
 *
 * Called during render of a client component; `window` is guarded anyway so a
 * server prerender falls back to the shared constant rather than throwing.
 */
function resolveApiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.endsWith('/') ? configured : `${configured}/`;
  if (typeof window !== 'undefined') return `${window.location.origin}/api/`;
  return API_URL;
}

/**
 * The stdio client config, with this deployment's API URL already filled in.
 *
 * `cwd` and PYTHONPATH name the same directory on purpose, as docs/mcp/clients.md
 * does: clients disagree about which one they honour, and either alone makes
 * `python -m mcp_server` resolve. Setting both means the snippet works wherever
 * it is pasted.
 */
function mcpConfigSnippet(key: string, apiUrl: string): string {
  const backend = '<path to>/ConsultancyDev/backend';
  return JSON.stringify(
    {
      mcpServers: {
        'consultancy-dev': {
          command: 'python',
          args: ['-m', 'mcp_server'],
          cwd: backend,
          env: {
            PYTHONPATH: backend,
            CONSULTANCY_API_URL: apiUrl,
            CONSULTANCY_API_KEY: key,
          },
        },
      },
    },
    null,
    2,
  );
}

export function ApiKeysCard() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState<'key' | 'config' | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const keys = useQuery({
    queryKey: ['apiKeys'],
    queryFn: () => apiClient.apiKeys.list({ page_size: 100 }),
  });

  const create = useMutation({
    mutationFn: () =>
      apiClient.apiKeys.create(name.trim(), expiresAt ? new Date(expiresAt).toISOString() : null),
    onSuccess: (data) => {
      setCreated(data);
      setIsCreateOpen(false);
      setName('');
      setExpiresAt('');
      void queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: number) => apiClient.apiKeys.revoke(id),
    onSuccess: () => {
      setRevokeTarget(null);
      toast.success('Key revoked', 'Clients using it stop working immediately.');
      void queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
    },
    onError: (error: unknown) => {
      setRevokeTarget(null);
      toast.error('Could not revoke the key', getApiErrorMessage(error));
    },
  });

  /**
   * Closes the reveal modal and drops the plaintext key from memory.
   *
   * `create.reset()` matters as much as clearing our own state: the mutation
   * observer holds its last result, and that result IS the `ApiKeyCreated`
   * object with the plaintext in it. Without the reset the key stays reachable
   * for the life of the page, and for `gcTime` after unmount.
   */
  const dismissCreated = () => {
    setCreated(null);
    setCopied(null);
    create.reset();
  };

  // Same reason, for the user who navigates away with the modal still open.
  // `reset` is bound once by the mutation observer and keeps a stable identity
  // across renders, so this cleanup runs on unmount only.
  const resetCreate = create.reset;
  useEffect(() => () => resetCreate(), [resetCreate]);

  const apiUrl = resolveApiUrl();

  const copy = async (what: 'key' | 'config') => {
    if (!created) return;
    const text = what === 'key' ? created.key : mcpConfigSnippet(created.key, apiUrl);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error('Could not copy', 'Select the text and copy it manually.');
    }
  };

  const rows = keys.data?.results ?? [];

  return (
    <>
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Bot size={14} className="text-slate-400" /> AI access keys
            </h3>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => {
                create.reset();
                setName('');
                setExpiresAt('');
                setIsCreateOpen(true);
              }}
            >
              <Plus size={12} /> New key
            </Button>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Let an AI assistant (Claude, ChatGPT, Cursor…) work in the CRM as you through the MCP server. A
            key has exactly your permissions. Revoke it the moment you stop using it.
          </p>

          {keys.isError && (
            <div className="mb-3">
              <ErrorBanner error={keys.error} />
            </div>
          )}

          {keys.isLoading && (
            <div className="flex items-center gap-2 py-3 text-xs text-slate-500">
              <InlineSpinner /> Loading your keys…
            </div>
          )}

          {!keys.isLoading && !keys.isError && rows.length === 0 && (
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-center text-xs text-slate-500">
              No keys yet.
            </p>
          )}

          {rows.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {rows.map((key) => {
                const status = keyStatus(key);
                return (
                  <li key={key.id} className="flex items-center gap-3 py-2">
                    <KeyRound size={14} className="shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-800">
                        {key.name} <span className="font-mono text-xs text-slate-400">{key.prefix}…</span>
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Created {formatDate(key.created_at)} · Last used {formatDate(key.last_used_at)}
                        {key.expires_at ? ` · Expires ${formatDate(key.expires_at)}` : ''}
                        {key.revoked_at ? ` · Revoked ${formatDate(key.revoked_at)}` : ''}
                      </p>
                    </div>
                    <Badge className={STATUS_CLASS[status]}>{status}</Badge>
                    {status === 'Active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => setRevokeTarget(key)}
                        aria-label={`Revoke ${key.name}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Modal
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        size="sm"
        title="New AI access key"
        description="Name it after the client that will use it. You will see the key once."
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:w-28"
              onClick={() => setIsCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="api-key-form"
              className="h-11 bg-slate-900 hover:bg-slate-800 sm:w-40"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? (
                <>
                  <InlineSpinner className="mr-2" /> Creating…
                </>
              ) : (
                'Create key'
              )}
            </Button>
          </div>
        }
      >
        <form
          id="api-key-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          {create.isError && <ErrorBanner error={create.error} />}
          <div className="space-y-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              className="h-11"
              placeholder="Claude Desktop on my laptop"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key-expires">Expires (optional)</Label>
            <Input
              id="api-key-expires"
              type="datetime-local"
              className="h-11"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-slate-500">
              Leave empty for a key that never expires. You can revoke it at any time.
            </p>
          </div>
        </form>
      </Modal>

      <Modal
        open={created !== null}
        onClose={dismissCreated}
        size="md"
        title="Copy your key now"
        description="This is the only time it is shown. Paste it into your AI client's configuration."
        footer={
          <div className="flex justify-end">
            <Button className="h-11 bg-slate-900 hover:bg-slate-800 sm:w-32" onClick={dismissCreated}>
              Done
            </Button>
          </div>
        }
      >
        {created && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key-plaintext">Key</Label>
              <div className="flex gap-2">
                <Input
                  id="api-key-plaintext"
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 font-mono text-xs"
                  value={created.key}
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-24 gap-1"
                  onClick={() => copy('key')}
                >
                  {copied === 'key' ? <Check size={14} /> : <Copy size={14} />} Copy
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium leading-none text-slate-900">MCP client config (stdio)</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 text-xs"
                  onClick={() => copy('config')}
                >
                  {copied === 'config' ? <Check size={12} /> : <Copy size={12} />} Copy config
                </Button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-md bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                {mcpConfigSnippet(created.key, apiUrl)}
              </pre>
              <p className="text-xs text-slate-500">
                Running the server over HTTP instead (
                <code className="font-mono">--transport streamable-http</code>)? Point the client at that
                server&apos;s <code className="font-mono">/mcp</code> endpoint and send the header{' '}
                <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
        title="Revoke this key?"
        description={`"${revokeTarget?.name ?? ''}" will stop working immediately. This cannot be undone.`}
        confirmText="Revoke"
        confirmVariant="destructive"
        isLoading={revoke.isPending}
      />
    </>
  );
}
