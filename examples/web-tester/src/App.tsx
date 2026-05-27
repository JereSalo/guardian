import { useCallback, useEffect, useState } from 'react';
import type { MidenClient } from '@miden-sdk/miden-sdk';
import type {
  Multisig,
  MultisigClient,
  Proposal,
  ConsumableNote,
} from '@openzeppelin/miden-multisig-client';

import { ProfileBar } from '@/components/ProfileBar';
import { Settings } from '@/components/Settings';
import { SetupPanel } from '@/components/SetupPanel';
import { MultisigPanel } from '@/components/MultisigPanel';
import {
  listProfiles,
  createProfile,
  deleteProfile,
  updateProfile,
  getActiveProfileId,
  setActiveProfileId,
  type ProfileRecord,
} from '@/lib/profiles';
import {
  createMidenClient,
  initMultisigClient,
  createMultisig,
  loadMultisig,
  syncAll,
  proposeConsumeNotes,
  signProposal,
  executeProposal,
  unbindAccountKey,
  discoverAccountsForProfile,
} from '@/lib/flows';
import { loadSettings, saveSettings, type Settings as SettingsType } from '@/config';
import { logger } from '@/lib/log';

const log = logger('App');

type ClientBundle = {
  midenClient: MidenClient;
  multisigClient: MultisigClient;
  guardianCommitment: string;
};

export default function App() {
  const [settings, setSettings] = useState<SettingsType>(() => loadSettings());
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveProfileId());
  const [bundle, setBundle] = useState<ClientBundle | null>(null);
  const [multisig, setMultisig] = useState<Multisig | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [notes, setNotes] = useState<ConsumableNote[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // True while bundle init / discover / auto-load is in flight. While true we
  // suppress the SetupPanel so the user can't fire Create before discovery
  // tells us whether a multisig already exists for this profile.
  const [bootstrapping, setBootstrapping] = useState<boolean>(false);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

  // Initial profile load
  useEffect(() => {
    void listProfiles().then((list) => {
      log.info('initial profiles', list.map((p) => ({ id: p.id, name: p.name, lastAccountId: p.lastAccountId })));
      setProfiles(list);
    });
  }, []);

  // Build clients whenever the *identity* of the active profile (or settings)
  // changes. The dep list intentionally watches `activeProfile?.id`, NOT the
  // whole object: rememberAccountId mutates the profiles array (new object
  // identity) every time we persist `lastAccountId`, and we don't want that to
  // tear down the multisig we just loaded.
  useEffect(() => {
    let cancelled = false;
    if (!activeProfile) {
      log.info('no active profile, clearing bundle');
      setBundle(null);
      setMultisig(null);
      setProposals([]);
      setNotes([]);
      setBootstrapping(false);
      return;
    }
    log.info('building bundle for profile', { id: activeProfile.id, name: activeProfile.name });
    setBootstrapping(true);
    setStatus('Initializing clients…');
    setError(null);
    // Tear down old multisig state immediately so the UI doesn't keep showing
    // the previous profile's account while the new clients spin up.
    setMultisig(null);
    setProposals([]);
    setNotes([]);
    (async () => {
      try {
        const midenClient = await createMidenClient(settings.midenRpcUrl, activeProfile.midenDbName);
        const { client: multisigClient, guardianCommitment } = await initMultisigClient(
          midenClient,
          settings.guardianEndpoint,
          settings.midenRpcUrl,
        );
        if (cancelled) return;
        const newBundle: ClientBundle = { midenClient, multisigClient, guardianCommitment };
        setBundle(newBundle);
        setStatus(`Ready. Guardian commitment: ${guardianCommitment.slice(0, 16)}…`);

        // Decide which accountId (if any) to auto-load. We try, in order:
        //   1. `lastAccountId` persisted on the profile (this profile did
        //      Create/Load locally before).
        //   2. Guardian-side discovery via recoverByKey: any account that
        //      authorizes this profile's commitment, even if this profile was
        //      only added as a cosigner by someone else.
        //      - If exactly one match, auto-load it (and persist as lastAccountId).
        //      - If multiple matches, surface them via status so the user can
        //        pick one with "Load existing" rather than guess.
        let targetAccountId: string | null = activeProfile.lastAccountId ?? null;
        if (!targetAccountId) {
          try {
            const matches = await discoverAccountsForProfile(multisigClient, activeProfile);
            if (cancelled) return;
            if (matches.length === 1) {
              targetAccountId = matches[0];
              log.info('discovered single multisig for profile; auto-loading', { accountId: targetAccountId });
            } else if (matches.length > 1) {
              log.info('discovered multiple multisigs for profile', { count: matches.length });
              setStatus(`Found ${matches.length} multisigs for ${activeProfile.name}: ${matches.join(', ')}. Use "Load existing" to pick one.`);
            } else {
              log.info('no Guardian-side multisig matches for profile', { profile: activeProfile.name });
            }
          } catch (e) {
            // Discovery is best-effort - failing here should not block the user
            // from using Create / Load. Surface as a status note, not an error.
            log.warn('discoverAccountsForProfile failed', (e as Error).message);
            setStatus(`Could not discover multisigs for ${activeProfile.name}: ${(e as Error).message}`);
          }
        }

        if (targetAccountId) {
          log.info('auto-loading multisig', { accountId: targetAccountId });
          setStatus(`Reloading ${targetAccountId}…`);
          try {
            const m = await loadMultisig(multisigClient, activeProfile, targetAccountId);
            if (cancelled) return;
            setMultisig(m);
            // Persist so the next switch / reload reuses lastAccountId fast-path.
            if (targetAccountId !== activeProfile.lastAccountId) {
              const updated = await updateProfile(activeProfile.id, { lastAccountId: targetAccountId });
              if (!cancelled && updated) {
                setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
              }
            }
            // Best-effort sync. Soft errors (stale proposal binding, transient
            // RPC blip) are surfaced but do NOT drop the loaded multisig.
            const result = await syncAll(midenClient, m);
            if (cancelled) return;
            setProposals(result.proposals);
            setNotes(result.notes);
            const summary = `Loaded ${m.accountId} (${result.proposals.length} proposal(s), ${result.notes.length} note(s))`;
            if (result.errors.length) {
              const reasons = result.errors.map((e) => `${e.step}: ${e.message}`).join('; ');
              log.warn('partial sync after auto-load', result.errors);
              setError(`Partial sync (${result.errors.length} issue(s)): ${reasons}`);
              setStatus(summary);
            } else {
              setStatus(summary);
            }
          } catch (e) {
            const err = e as Error;
            log.error('auto-load failed (hard error from load itself)', err);
            setError(`Auto-load of ${targetAccountId} failed: ${err.message}. You can load a different account or create a new one.`);
            setStatus('');
          }
        }
      } catch (e) {
        if (!cancelled) {
          const err = e as Error;
          log.error('failed to init clients', err);
          setError(`Failed to init clients: ${err.message}`);
          setStatus('');
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately depend on `activeProfile?.id` rather than `activeProfile`
    // so updates to mutable fields like `lastAccountId` don't trigger a full
    // bundle rebuild (which would unload the live multisig).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, settings.guardianEndpoint, settings.midenRpcUrl]);

  const refresh = useCallback(async (m: Multisig) => {
    if (!bundle) return;
    log.debug('refresh start', { accountId: m.accountId });
    const result = await syncAll(bundle.midenClient, m);
    setProposals(result.proposals);
    setNotes(result.notes);
    if (result.errors.length) {
      const reasons = result.errors.map((e) => `${e.step}: ${e.message}`).join('; ');
      log.warn('refresh: partial sync', result.errors);
      setError(`Partial sync (${result.errors.length} issue(s)): ${reasons}`);
    }
    log.debug('refresh done', { proposals: result.proposals.length, notes: result.notes.length, errors: result.errors.length });
  }, [bundle]);

  const handleSwitch = (id: string) => {
    log.info('switch profile', { id, name: profiles.find((p) => p.id === id)?.name });
    setActiveProfileId(id);
    setActiveId(id);
  };

  const handleCreateProfile = async (name: string) => {
    setError(null);
    try {
      const p = await createProfile(name);
      setProfiles((prev) => [...prev, p]);
      setActiveProfileId(p.id);
      setActiveId(p.id);
    } catch (e) {
      const err = e as Error;
      log.error('create profile failed', err);
      setError(`Create profile failed: ${err.message}`);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    setError(null);
    try {
      log.info('deleting profile', { id });
      await deleteProfile(id);
      const next = profiles.filter((p) => p.id !== id);
      setProfiles(next);
      if (activeId === id) {
        const fallback = next[0]?.id ?? null;
        setActiveProfileId(fallback);
        setActiveId(fallback);
      }
    } catch (e) {
      const err = e as Error;
      log.error('delete profile failed', err);
      setError(`Delete profile failed: ${err.message}`);
    }
  };

  const handleApplySettings = (next: SettingsType) => {
    log.info('apply settings', next);
    saveSettings(next);
    setSettings(next);
  };

  // After create/load succeeds, persist the accountId on the profile so the
  // next profile-switch / reload picks it up automatically.
  const rememberAccountId = useCallback(async (accountId: string) => {
    if (!activeProfile) return;
    const updated = await updateProfile(activeProfile.id, { lastAccountId: accountId });
    if (updated) {
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    }
  }, [activeProfile]);

  const handleCreateMultisig = async (threshold: number, otherCommitments: string[]) => {
    if (!bundle || !activeProfile) return;
    setBusyKey('create');
    setError(null);
    setStatus('Creating multisig…');
    try {
      const m = await createMultisig(
        bundle.multisigClient,
        activeProfile,
        otherCommitments,
        threshold,
        bundle.guardianCommitment,
      );
      setMultisig(m);
      await rememberAccountId(m.accountId);
      setStatus(`Created multisig ${m.accountId}`);
      await refresh(m);
    } catch (e) {
      const err = e as Error;
      log.error('create multisig failed', err);
      const msg = err.message;
      // The SDK's bindAccountKey rejects a second account on the same
      // profile (one key, one binding locally). Translate that into UX
      // guidance instead of a raw error.
      if (msg.includes('is already bound to account')) {
        setError(
          `${msg}. Click "Unload" on the existing multisig first (it clears the local key binding), ` +
          `or create a different profile if you want both multisigs visible simultaneously.`,
        );
      } else {
        setError(`Create multisig failed: ${msg}`);
      }
      setStatus('');
    } finally {
      setBusyKey(null);
    }
  };

  const handleLoadMultisig = async (accountId: string) => {
    if (!bundle || !activeProfile) return;
    setBusyKey('load');
    setError(null);
    setStatus(`Loading ${accountId}…`);
    try {
      const m = await loadMultisig(bundle.multisigClient, activeProfile, accountId);
      setMultisig(m);
      await rememberAccountId(m.accountId);
      setStatus(`Loaded ${m.accountId}`);
      await refresh(m);
    } catch (e) {
      const err = e as Error;
      log.error('load multisig failed', err);
      const msg = err.message;
      if (msg.includes('is already bound to account')) {
        setError(
          `${msg}. This profile is already bound to a different multisig locally. ` +
          `Click "Unload" on that one first, or use a different profile.`,
        );
      } else {
        setError(`Load multisig failed: ${msg}`);
      }
      setStatus('');
    } finally {
      setBusyKey(null);
    }
  };

  const handleUnloadMultisig = async () => {
    if (!activeProfile || !bundle) return;
    log.info('unloading multisig from profile', { profile: activeProfile.name });
    setMultisig(null);
    setProposals([]);
    setNotes([]);
    // Free the signer-key → account binding in the local miden-client keystore
    // so that creating or loading a different multisig with this profile does
    // not hit the SDK's "Signer commitment X is already bound to account Y"
    // guard (FalconSigner.bindAccountKey).
    await unbindAccountKey(bundle.midenClient, activeProfile.commitment);
    setStatus('Unloaded. The profile key is now free to bind to a different multisig.');
    const updated = await updateProfile(activeProfile.id, { lastAccountId: undefined });
    if (updated) {
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    }
  };

  const handleSync = async () => {
    if (!multisig) return;
    setBusyKey('sync');
    setError(null);
    try {
      await refresh(multisig);
      setStatus('Synced.');
    } catch (e) {
      const err = e as Error;
      log.error('sync failed', err);
      setError(`Sync failed: ${err.message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handlePropose = async (noteIds: string[]) => {
    if (!multisig) return;
    setBusyKey('propose');
    setError(null);
    try {
      const p = await proposeConsumeNotes(multisig, noteIds);
      setStatus(`Proposed ${p.id.slice(0, 16)}…`);
      await refresh(multisig);
    } catch (e) {
      const err = e as Error;
      log.error('propose failed', err);
      setError(`Propose failed: ${err.message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleSign = async (proposalId: string) => {
    if (!multisig) return;
    setBusyKey(`sign:${proposalId}`);
    setError(null);
    try {
      await signProposal(multisig, proposalId);
      setStatus(`Signed ${proposalId.slice(0, 16)}…`);
      await refresh(multisig);
    } catch (e) {
      const err = e as Error;
      log.error('sign failed', err);
      setError(`Sign failed: ${err.message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExecute = async (proposalId: string) => {
    if (!multisig) return;
    setBusyKey(`exec:${proposalId}`);
    setError(null);
    try {
      await executeProposal(multisig, proposalId);
      setStatus(`Executed ${proposalId.slice(0, 16)}…`);
      await refresh(multisig);
    } catch (e) {
      const err = e as Error;
      log.error('execute failed', err);
      setError(`Execute failed: ${err.message}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 bg-zinc-950 px-4 py-3">
        <h1 className="text-lg font-semibold">Miden Multisig Tester</h1>
      </header>
      <Settings settings={settings} onApply={handleApplySettings} />
      <ProfileBar
        profiles={profiles}
        activeId={activeId}
        onSwitch={handleSwitch}
        onCreate={handleCreateProfile}
        onDelete={handleDeleteProfile}
      />
      {(status || error) && (
        <div className="px-4 py-2 text-xs border-b border-zinc-800 bg-zinc-950/40">
          {error ? (
            <span className="text-red-400">⚠ {error}</span>
          ) : (
            <span className="text-zinc-400">{status}</span>
          )}
        </div>
      )}
      {!activeProfile ? (
        <div className="px-4 py-12 text-center text-zinc-500">
          Create a profile to start.
        </div>
      ) : bootstrapping || !bundle ? (
        <div className="px-4 py-12 flex flex-col items-center gap-3 text-zinc-400">
          <svg
            className="animate-spin h-6 w-6 text-indigo-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
          <div className="text-sm">{status || 'Loading…'}</div>
          <div className="text-xs text-zinc-500">
            Checking the Guardian for any multisig that involves this profile…
          </div>
        </div>
      ) : !multisig ? (
        <SetupPanel
          myCommitment={activeProfile.commitment}
          guardianCommitment={bundle.guardianCommitment}
          busy={busyKey === 'create' || busyKey === 'load'}
          onCreate={handleCreateMultisig}
          onLoad={handleLoadMultisig}
        />
      ) : (
        <MultisigPanel
          multisig={multisig}
          profile={activeProfile}
          proposals={proposals}
          notes={notes}
          busyKey={busyKey}
          onSync={handleSync}
          onProposeConsume={handlePropose}
          onSign={handleSign}
          onExecute={handleExecute}
          onUnload={handleUnloadMultisig}
        />
      )}
    </div>
  );
}
