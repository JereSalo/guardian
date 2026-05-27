import { useState } from 'react';
import type { Multisig, Proposal, ConsumableNote } from '@openzeppelin/miden-multisig-client';
import { Button } from './Button';
import type { ProfileRecord } from '@/lib/profiles';

type Props = {
  multisig: Multisig;
  profile: ProfileRecord;
  proposals: Proposal[];
  notes: ConsumableNote[];
  busyKey: string | null;
  onSync: () => void;
  onProposeConsume: (noteIds: string[]) => void;
  onSign: (proposalId: string) => void;
  onExecute: (proposalId: string) => void;
  onUnload: () => void;
};

function short(hex: string, head = 10, tail = 6): string {
  if (hex.length <= head + tail + 3) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function MultisigPanel({
  multisig,
  profile,
  proposals,
  notes,
  busyKey,
  onSync,
  onProposeConsume,
  onSign,
  onExecute,
  onUnload,
}: Props) {
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());

  const isMine = (commitment: string) => commitment === profile.commitment;

  return (
    <div className="px-4 py-4 space-y-6">
      <section className="border border-zinc-800 rounded p-4 bg-zinc-900/30">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Multisig account</h2>
          <div className="flex gap-2">
            <Button onClick={onSync} disabled={busyKey === 'sync'}>
              {busyKey === 'sync' ? 'Syncing…' : 'Sync'}
            </Button>
            <Button variant="ghost" onClick={onUnload} title="Forget this multisig on this profile (does not delete it on the Guardian)">
              Unload
            </Button>
          </div>
        </div>
        <div className="space-y-1 text-sm">
          <div>
            <span className="text-zinc-500">ID:</span>{' '}
            <span className="font-mono">{multisig.accountId}</span>{' '}
            <button
              onClick={() => navigator.clipboard.writeText(multisig.accountId)}
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              copy
            </button>
          </div>
          <div>
            <span className="text-zinc-500">Threshold:</span> {multisig.threshold} of{' '}
            {multisig.signerCommitments.length}
          </div>
          <div className="space-y-0.5 pt-2">
            <div className="text-zinc-500 text-xs uppercase tracking-wide">Cosigners</div>
            {multisig.signerCommitments.map((c) => (
              <div key={c} className="font-mono text-xs">
                {short(c, 16, 8)}
                {isMine(c) && (
                  <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-900 text-indigo-200">
                    this profile
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="pt-2">
            <span className="text-zinc-500">Guardian:</span>{' '}
            <span className="font-mono text-xs">{short(multisig.guardianCommitment, 16, 8)}</span>
          </div>
        </div>
      </section>

      <section className="border border-zinc-800 rounded p-4 bg-zinc-900/30">
        <h3 className="text-base font-semibold mb-3">Consumable notes</h3>
        {notes.length === 0 ? (
          <p className="text-zinc-500 text-sm">No consumable notes. Mint to the account ID above from the devnet faucet, then click Sync.</p>
        ) : (
          <div className="space-y-2">
            {notes.map((n) => (
              <label key={n.id} className="flex items-center gap-3 text-sm font-mono">
                <input
                  type="checkbox"
                  checked={selectedNotes.has(n.id)}
                  onChange={(e) => {
                    setSelectedNotes((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(n.id);
                      else next.delete(n.id);
                      return next;
                    });
                  }}
                />
                <span>{short(n.id, 12, 6)}</span>
                <span className="text-zinc-400">
                  {n.assets.map((a) => `${a.amount} (faucet ${short(a.faucetId, 8, 4)})`).join(', ')}
                </span>
              </label>
            ))}
            <Button
              disabled={selectedNotes.size === 0 || busyKey === 'propose'}
              onClick={() => {
                onProposeConsume(Array.from(selectedNotes));
                setSelectedNotes(new Set());
              }}
            >
              {busyKey === 'propose' ? 'Proposing…' : `Propose ConsumeNotes (${selectedNotes.size})`}
            </Button>
          </div>
        )}
      </section>

      <section className="border border-zinc-800 rounded p-4 bg-zinc-900/30">
        <h3 className="text-base font-semibold mb-3">Proposals</h3>
        {proposals.length === 0 ? (
          <p className="text-zinc-500 text-sm">No pending proposals.</p>
        ) : (
          <div className="space-y-3">
            {proposals.map((p) => {
              const signed = new Set(p.signatures.map((s) => s.signerId.toLowerCase()));
              const collected = signed.size;
              const required = multisig.threshold;
              const alreadySigned = signed.has(profile.commitment.toLowerCase());
              const ready = p.status === 'ready' || collected >= required;
              return (
                <div key={p.id} className="border border-zinc-800 rounded p-3 bg-zinc-950/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-xs">{short(p.id, 16, 8)}</span>
                    <span className="text-xs text-zinc-400">
                      {p.metadata.proposalType} · {collected}/{required}{' '}
                      {ready ? '· READY' : ''}
                    </span>
                  </div>
                  <div className="space-y-0.5 mb-3 text-xs font-mono">
                    {multisig.signerCommitments.map((c) => (
                      <div key={c}>
                        {signed.has(c.toLowerCase()) ? '✓' : '·'} {short(c, 14, 6)}
                        {isMine(c) && <span className="ml-2 text-indigo-300">(you)</span>}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={alreadySigned || ready || busyKey === `sign:${p.id}`}
                      onClick={() => onSign(p.id)}
                      title={alreadySigned ? 'Already signed by this profile' : ready ? 'Threshold already reached' : ''}
                    >
                      {busyKey === `sign:${p.id}` ? 'Signing…' : alreadySigned ? 'Signed' : 'Sign'}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!ready || busyKey === `exec:${p.id}`}
                      onClick={() => onExecute(p.id)}
                    >
                      {busyKey === `exec:${p.id}` ? 'Executing…' : 'Execute'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
