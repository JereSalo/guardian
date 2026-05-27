import { useState } from 'react';
import { Button } from './Button';

type Props = {
  myCommitment: string;
  guardianCommitment: string;
  busy: boolean;
  onCreate: (threshold: number, otherCommitments: string[]) => void;
  onLoad: (accountId: string) => void;
};

export function SetupPanel({ myCommitment, guardianCommitment, busy, onCreate, onLoad }: Props) {
  const [mode, setMode] = useState<'create' | 'load' | null>(null);

  if (!mode) {
    return (
      <div className="px-4 py-8 flex flex-col items-center gap-4">
        <p className="text-zinc-400">No multisig loaded for this profile. Create one or load an existing one.</p>
        <div className="flex gap-3">
          <Button onClick={() => setMode('create')}>Create new multisig</Button>
          <Button variant="secondary" onClick={() => setMode('load')}>
            Load existing
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'create') {
    return <CreateForm myCommitment={myCommitment} guardianCommitment={guardianCommitment} busy={busy} onCreate={onCreate} onCancel={() => setMode(null)} />;
  }

  return <LoadForm busy={busy} onLoad={onLoad} onCancel={() => setMode(null)} />;
}

function CreateForm({
  myCommitment,
  guardianCommitment,
  busy,
  onCreate,
  onCancel,
}: {
  myCommitment: string;
  guardianCommitment: string;
  busy: boolean;
  onCreate: (threshold: number, otherCommitments: string[]) => void;
  onCancel: () => void;
}) {
  const [threshold, setThreshold] = useState(2);
  const [others, setOthers] = useState('');

  const parsedOthers = others
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const totalCosigners = 1 + parsedOthers.length;
  const valid = parsedOthers.every((c) => /^0x[0-9a-fA-F]+$/.test(c)) && threshold >= 1 && threshold <= totalCosigners;

  return (
    <div className="px-4 py-6 max-w-xl mx-auto space-y-4">
      <h2 className="text-lg font-semibold">Create multisig</h2>
      <div className="text-sm space-y-2">
        <div>
          <span className="text-zinc-500">Your commitment:</span>{' '}
          <span className="font-mono text-xs">{myCommitment}</span>
        </div>
        <div>
          <span className="text-zinc-500">Guardian commitment:</span>{' '}
          <span className="font-mono text-xs">{guardianCommitment || '...'}</span>
        </div>
      </div>
      <label className="block text-sm">
        <span className="text-zinc-400">Other cosigners (paste commitments, one per line)</span>
        <textarea
          value={others}
          onChange={(e) => setOthers(e.target.value)}
          rows={4}
          placeholder="0xabc...\n0xdef..."
          className="mt-1 block w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-xs"
        />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-400">Threshold</span>
        <input
          type="number"
          value={threshold}
          min={1}
          max={Math.max(1, totalCosigners)}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="ml-2 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-20"
        />
        <span className="ml-2 text-zinc-500 text-xs">of {totalCosigners}</span>
      </label>
      <div className="flex gap-2">
        <Button disabled={!valid || busy} onClick={() => onCreate(threshold, parsedOthers)}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LoadForm({ busy, onLoad, onCancel }: { busy: boolean; onLoad: (id: string) => void; onCancel: () => void }) {
  const [accountId, setAccountId] = useState('');
  return (
    <div className="px-4 py-6 max-w-xl mx-auto space-y-4">
      <h2 className="text-lg font-semibold">Load existing multisig</h2>
      <label className="block text-sm">
        <span className="text-zinc-400">Account ID</span>
        <input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="0x..."
          className="mt-1 block w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 font-mono text-xs"
        />
      </label>
      <div className="flex gap-2">
        <Button disabled={!accountId.startsWith('0x') || busy} onClick={() => onLoad(accountId.trim())}>
          {busy ? 'Loading…' : 'Load'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
