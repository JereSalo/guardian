import { useEffect, useState } from 'react';
import { Button } from './Button';
import type { Settings as SettingsType } from '@/config';

type Props = {
  settings: SettingsType;
  onApply: (next: SettingsType) => void;
};

// A Guardian endpoint is either a same-origin relative path (e.g. /guardian-proxy)
// or an absolute http(s) URL.
function guardianFormatError(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Required';
  if (v.startsWith('/')) return null;
  return urlFormatError(v);
}

function urlFormatError(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Required';
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:' ? null : 'Must be http(s)';
  } catch {
    return 'Enter an http(s) URL';
  }
}

type Reach =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; commitment: string }
  | { kind: 'error'; message: string };

export function Settings({ settings, onApply }: Props) {
  const [guardian, setGuardian] = useState(settings.guardianEndpoint);
  const [rpc, setRpc] = useState(settings.midenRpcUrl);
  const [reach, setReach] = useState<Reach>({ kind: 'idle' });

  const guardianErr = guardianFormatError(guardian);
  const rpcErr = urlFormatError(rpc);
  const dirty = guardian !== settings.guardianEndpoint || rpc !== settings.midenRpcUrl;

  // Probe the Guardian's /pubkey so an unreachable or wrong URL surfaces before
  // it is applied. Debounced; a newer input aborts the in-flight probe.
  useEffect(() => {
    if (guardianFormatError(guardian)) {
      setReach({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setReach({ kind: 'checking' });
      fetch(`${guardian.trim()}/pubkey`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { commitment?: string };
          if (!body.commitment) throw new Error('no commitment in response');
          setReach({ kind: 'ok', commitment: body.commitment });
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setReach({ kind: 'error', message: e instanceof Error ? e.message : 'unreachable' });
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [guardian]);

  const inputCls = (error: string | null, width: string) =>
    `bg-zinc-800 border rounded px-2 py-1 font-mono text-xs ${width} ${
      error ? 'border-red-500' : 'border-zinc-700'
    }`;

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/30 px-4 py-3 flex items-center gap-3 flex-wrap text-sm">
      <span className="text-xs uppercase tracking-wide text-zinc-500">Settings</span>
      <label className="flex items-center gap-2">
        <span className="text-zinc-400">Guardian</span>
        <input
          value={guardian}
          onChange={(e) => setGuardian(e.target.value)}
          className={inputCls(guardianErr, 'w-80')}
        />
        <ReachBadge error={guardianErr} reach={reach} />
      </label>
      <label className="flex items-center gap-2">
        <span className="text-zinc-400">Miden RPC</span>
        <input
          value={rpc}
          onChange={(e) => setRpc(e.target.value)}
          className={inputCls(rpcErr, 'w-72')}
        />
        {rpcErr && <span className="text-xs text-red-400">{rpcErr}</span>}
      </label>
      <Button
        disabled={!dirty || !!rpcErr || reach.kind !== 'ok'}
        onClick={() => onApply({ guardianEndpoint: guardian.trim(), midenRpcUrl: rpc.trim() })}
      >
        Apply
      </Button>
    </div>
  );
}

function ReachBadge({ error, reach }: { error: string | null; reach: Reach }) {
  if (error) return <span className="text-xs text-red-400">{error}</span>;
  switch (reach.kind) {
    case 'checking':
      return <span className="text-xs text-zinc-500">checking…</span>;
    case 'ok':
      return (
        <span className="text-xs text-emerald-400" title={`commitment ${reach.commitment}`}>
          ✓ reachable
        </span>
      );
    case 'error':
      return (
        <span className="text-xs text-red-400" title={reach.message}>
          ✗ {reach.message}
        </span>
      );
    default:
      return null;
  }
}
