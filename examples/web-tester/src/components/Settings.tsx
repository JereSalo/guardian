import { useState } from 'react';
import { Button } from './Button';
import type { Settings as SettingsType } from '@/config';

type Props = {
  settings: SettingsType;
  onApply: (next: SettingsType) => void;
};

export function Settings({ settings, onApply }: Props) {
  const [guardian, setGuardian] = useState(settings.guardianEndpoint);
  const [rpc, setRpc] = useState(settings.midenRpcUrl);
  const dirty = guardian !== settings.guardianEndpoint || rpc !== settings.midenRpcUrl;

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/30 px-4 py-3 flex items-center gap-3 flex-wrap text-sm">
      <span className="text-xs uppercase tracking-wide text-zinc-500">Settings</span>
      <label className="flex items-center gap-2">
        <span className="text-zinc-400">Guardian</span>
        <input
          value={guardian}
          onChange={(e) => setGuardian(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-80 font-mono text-xs"
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="text-zinc-400">Miden RPC</span>
        <input
          value={rpc}
          onChange={(e) => setRpc(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 w-72 font-mono text-xs"
        />
      </label>
      <Button
        disabled={!dirty}
        onClick={() => onApply({ guardianEndpoint: guardian, midenRpcUrl: rpc })}
      >
        Apply
      </Button>
    </div>
  );
}
