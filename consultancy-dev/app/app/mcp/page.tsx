'use client';

import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/store/toastStore';
import { ApiKeysCard } from '../profile/components/ApiKeysCard';

const subscribe = () => () => {};

export default function McpPage() {
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => '');
  const endpoint = origin ? `${origin}/mcp` : '';
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
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Bot className="text-teal-600" /> Connect AI / MCP</h1>
        <p className="mt-2 text-sm text-slate-600">Connect your AI assistant to your company’s CRM using your own account permissions.</p>
      </div>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-900">Connect your assistant</h2>
            <span role="status" className={`text-xs ${health.isError ? 'text-amber-700' : 'text-teal-700'}`}>
              {health.isPending ? 'Checking connection…' : health.isError ? 'Server unavailable — try again shortly' : 'MCP server online'}
            </span>
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
            <li>Create an AI access key below and copy it when it appears.</li>
            <li>In your assistant’s MCP settings, add a remote server using the URL below and Streamable HTTP.</li>
            <li>Set the Authorization header to <code className="break-all">Bearer &lt;your key&gt;</code>, or paste the key into its bearer-token field.</li>
            <li>Connect, then ask the assistant “Who am I?” to verify your account.</li>
          </ol>
          <div className="space-y-2">
            <Label htmlFor="mcp-url">MCP server URL</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="mcp-url" readOnly value={endpoint} className="min-w-0 font-mono text-xs" onFocus={(event) => event.target.select()} />
              <Button variant="outline" disabled={!endpoint} onClick={async () => {
                try {
                  await navigator.clipboard.writeText(endpoint);
                  toast.success('MCP URL copied');
                } catch { toast.error('Could not copy', 'Select the URL and copy it manually.'); }
              }}><Copy size={14} className="mr-2" /> Copy URL</Button>
            </div>
          </div>
          <p className="text-xs text-slate-500">Use an MCP client that supports bearer tokens or custom headers. This server does not provide OAuth sign-in. The URL is for your assistant’s settings; opening it as a webpage will not connect your account.</p>
        </CardContent>
      </Card>
      <ApiKeysCard />
    </div>
  );
}
