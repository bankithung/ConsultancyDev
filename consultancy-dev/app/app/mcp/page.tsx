'use client';

import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Bot, Check, Copy, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/store/toastStore';
import { ApiKeysCard } from '../profile/components/ApiKeysCard';

const subscribe = () => () => {};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <Input aria-label={label} readOnly value={value} className="h-9 min-w-0 bg-slate-50/70 font-mono text-xs" onFocus={(event) => event.target.select()} />
        <Button variant="outline" size="sm" disabled={!value} className="h-9 shrink-0 gap-1.5" aria-label={`Copy ${label}`} onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { toast.error('Could not copy', 'Select the text and copy it manually.'); }
        }}>{copied ? <Check size={13} /> : <Copy size={13} />}<span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span></Button>
      </div>
    </div>
  );
}

export default function McpPage() {
  const [method, setMethod] = useState<'chatgpt' | 'api-key'>('chatgpt');
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => '');
  const health = useQuery({
    queryKey: ['mcp-health'],
    queryFn: async () => {
      const response = await fetch('/mcp/health');
      if (!response.ok) throw new Error('MCP unavailable');
      const data = await response.json();
      if (data.status !== 'ok') throw new Error('MCP unavailable');
      return data;
    },
    retry: 1,
    refetchInterval: 60000,
  });

  return (
    <div className="pt-1">
      <section aria-label="AI connections" className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600"><Bot size={19} /></div>
            <div><h1 className="text-sm font-semibold text-slate-900">AI connections</h1><p className="mt-0.5 text-xs text-slate-500">Your CRM, connected to your assistant.</p></div>
          </div>
          <span role="status" className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${health.isError ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700'}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />{health.isPending ? 'Checking' : health.isError ? 'Unavailable' : 'Online'}
          </span>
        </div>

        <div className="space-y-4 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div aria-label="Connection method" className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
              {(['chatgpt', 'api-key'] as const).map((value) => <button key={value} type="button" aria-pressed={method === value} className={`rounded-md px-3 py-1.5 text-xs font-medium ${method === value ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`} onClick={() => setMethod(value)}>{value === 'chatgpt' ? 'ChatGPT' : 'API key'}</button>)}
            </div>
            <a href="/oauth/connections/" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-teal-700">Manage connections <ArrowUpRight size={13} /></a>
          </div>
          <div className="space-y-4">
            <CopyField label="Server URL" value={origin ? `${origin}/mcp` : ''} />
            {method === 'chatgpt' ? <>
              <p className="text-xs leading-5 text-slate-600">In ChatGPT, create a custom connector, paste this URL, and choose <strong className="font-medium text-slate-800">OAuth</strong>. Add the client details below, then sign in and approve access.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <CopyField label="Client ID" value="consultancy-chatgpt" />
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600 sm:pt-6"><span>Client secret <strong className="ml-1 font-medium text-slate-800">Leave blank</strong></span><span>Auth method <code className="ml-1 text-slate-800">none</code></span><span>Scope <code className="ml-1 text-slate-800">crm</code></span></div>
              </div>
              <details className="group text-xs text-slate-500">
                <summary className="w-fit cursor-pointer font-medium hover:text-teal-700">Advanced OAuth settings</summary>
                <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
                  <CopyField label="Authorization URL" value={origin ? `${origin}/oauth/authorize/` : ''} />
                  <CopyField label="Token URL" value={origin ? `${origin}/oauth/token/` : ''} />
                  <CopyField label="Authorization server" value={origin} />
                  <CopyField label="Resource" value={origin ? `${origin}/mcp` : ''} />
                </div>
                <p className="mt-3 leading-5">Choose User-Defined OAuth Client. Leave registration URL and base scopes blank; keep OIDC off. The callback URL must match the one registered by your administrator.</p>
              </details>
            </> : <p className="flex items-start gap-2 text-xs leading-5 text-slate-600"><KeyRound size={14} className="mt-0.5 shrink-0 text-slate-400" /><span>Create a key below. Use Streamable HTTP and the header <code className="break-all text-slate-800">Authorization: Bearer &lt;key&gt;</code>.</span></p>}
          </div>
        </div>
        <div className="border-t border-slate-200"><ApiKeysCard embedded /></div>
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[11px] text-slate-500 sm:px-5">Connections use your existing company and role permissions.</div>
      </section>
    </div>
  );
}
