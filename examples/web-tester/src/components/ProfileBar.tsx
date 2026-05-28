import { useState } from 'react';
import type { ProfileRecord } from '@/lib/profiles';
import { Button } from './Button';

type Props = {
  profiles: ProfileRecord[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
};

export function ProfileBar({ profiles, activeId, onSwitch, onCreate, onDelete }: Props) {
  const [newName, setNewName] = useState('');
  const [copied, setCopied] = useState(false);
  const active = profiles.find((p) => p.id === activeId) ?? null;

  const copyCommitment = async () => {
    if (!active) return;
    await navigator.clipboard.writeText(active.commitment);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 flex items-center gap-3 flex-wrap">
      <span className="text-xs uppercase tracking-wide text-zinc-500">Profile</span>
      {profiles.length === 0 ? (
        <span className="text-zinc-500 text-sm">none</span>
      ) : (
        <select
          value={activeId ?? ''}
          onChange={(e) => onSwitch(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        >
          <option value="" disabled>
            select...
          </option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {active && (
        <>
          <button
            type="button"
            onClick={copyCommitment}
            title="Click to copy"
            className="text-xs text-zinc-400 font-mono inline-flex items-center gap-1 hover:text-zinc-100 break-all text-left"
          >
            <span className="text-zinc-500 shrink-0">commitment:</span>
            <span>{active.commitment}</span>
            <span className={`ml-1 shrink-0 ${copied ? 'text-emerald-400' : 'text-indigo-400'}`}>
              {copied ? '✓ copied' : 'copy'}
            </span>
          </button>
          <Button
            variant="ghost"
            onClick={() => {
              if (confirm(`Delete profile "${active.name}"? This also deletes its Miden client store.`)) {
                onDelete(active.id);
              }
            }}
          >
            Delete
          </Button>
        </>
      )}
      <div className="flex-1" />
      <input
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="new profile name"
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm w-40"
      />
      <Button
        onClick={() => {
          if (!newName.trim()) return;
          onCreate(newName.trim());
          setNewName('');
        }}
      >
        + New profile
      </Button>
    </div>
  );
}
