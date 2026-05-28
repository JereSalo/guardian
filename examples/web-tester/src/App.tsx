import { useCallback, useEffect, useRef, useState } from 'react';
import type { MidenClient } from '@miden-sdk/miden-sdk';
import type {
  Multisig,
  MultisigClient,
  Proposal,
  ConsumableNote,
  AccountState,
  VaultBalance,
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
  type SyncResult,
} from '@/lib/flows';
import { loadSettings, saveSettings, type Settings as SettingsType } from '@/config';
import { logger } from '@/lib/log';

const log = logger('App');

type SyncError = SyncResult['errors'][number];

// The Miden client guards against rolling back local state when the chain
// hasn't yet included the block from our most recent local mutation (e.g.
// just after executing a proposal). It self-heals on the next sync once
// the block lands, so we render it as a note instead of a hard error.
function isInformationalSyncError(e: SyncError): boolean {
  return e.step === 'syncState' && /Refusing to overwrite local state/i.test(e.message);
}

const LOCAL_AHEAD_NOTE = 'Local is ahead of chain - will reconcile once the block is included.';

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
  const [history, setHistory] = useState<Proposal[]>([]);
  const [notes, setNotes] = useState<ConsumableNote[]>([]);
  const [vaultBalances, setVaultBalances] = useState<VaultBalance[]>([]);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  // True while the bundle (MidenClient + MultisigClient) is being constructed.
  // We hide the SetupPanel only during this short window - until the bundle is
  // ready, neither Create nor Load can do anything anyway.
  const [bootstrapping, setBootstrapping] = useState<boolean>(false);
  // True while Guardian discovery (`recoverByKey`) is running. We DO render the
  // SetupPanel during this phase so the user can create or load without waiting
  // for the discovery (which can take a while if the WASM is still warming up
  // or the network is slow). If discovery finds a single multisig later and
  // the user hasn't loaded one in the meantime, we auto-load it.
  const [discovering, setDiscovering] = useState<boolean>(false);
  // Ref kept in sync with `multisig` so async work (discover, auto-load) can
  // bail out cheaply if the user already created/loaded something while we
  // were busy talking to the Guardian.
  const multisigRef = useRef<Multisig | null>(null);
  useEffect(() => { multisigRef.current = multisig; }, [multisig]);
  // Same idea for `busyKey`: the auto-refresh effects below read it from a ref
  // so they don't have to be re-installed every time the user clicks Sign etc.
  const busyKeyRef = useRef<string | null>(null);
  useEffect(() => { busyKeyRef.current = busyKey; }, [busyKey]);
  // BroadcastChannel for instant cross-tab notifications when this user's
  // own tabs (same browser, same origin) make a state change. Cross-machine
  // updates are picked up by the visibility-based polling further below.
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  // Refs to the active profile and bundle so the broadcast listener (mounted
  // once) can read current values without re-installing on every change.
  const activeProfileRef = useRef<ProfileRecord | null>(null);
  const bundleRef = useRef<ClientBundle | null>(null);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);
  useEffect(() => { bundleRef.current = bundle; }, [bundle]);

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
      setHistory([]);
      setNotes([]);
      setVaultBalances([]);
      setAccountState(null);
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
    setHistory([]);
    setNotes([]);
    setVaultBalances([]);
    setAccountState(null);
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
        setStatus(`Ready. Guardian commitment: ${guardianCommitment}`);
        // Unblock the SetupPanel here. The user shouldn't have to wait for the
        // Guardian round-trip below before being able to click Create / Load.
        setBootstrapping(false);

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
          setDiscovering(true);
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
          } finally {
            if (!cancelled) setDiscovering(false);
          }
        }

        // Skip auto-load if the user already created/loaded a multisig while
        // discovery was in flight - we don't want to clobber their work.
        if (targetAccountId && !multisigRef.current) {
          log.info('auto-loading multisig', { accountId: targetAccountId });
          setStatus(`Reloading ${targetAccountId}…`);
          try {
            const m = await loadMultisig(multisigClient, activeProfile, targetAccountId);
            if (cancelled || multisigRef.current) return;
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
            const result = await syncAll(midenClient, m, {
              guardianEndpoint: settings.guardianEndpoint,
              midenRpcEndpoint: settings.midenRpcUrl,
            });
            if (cancelled) return;
            setProposals(result.proposals);
            setHistory(result.history);
            setNotes(result.notes);
            setVaultBalances(result.vaultBalances);
            if (result.state) setAccountState(result.state);
            const baseSummary = `Loaded ${m.accountId} (${result.proposals.length} proposal(s), ${result.notes.length} note(s))`;
            const hard = result.errors.filter((e) => !isInformationalSyncError(e));
            const hasInfo = result.errors.some(isInformationalSyncError);
            if (hard.length) {
              const reasons = hard.map((e) => `${e.step}: ${e.message}`).join('; ');
              log.warn('partial sync after auto-load', hard);
              setError(`Partial sync (${hard.length} issue(s)): ${reasons}`);
            }
            setStatus(hasInfo ? `${baseSummary}. ${LOCAL_AHEAD_NOTE}` : baseSummary);
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

  // `'updated'` means: I just changed state for an account I have loaded (sign,
  // execute, propose). Other tabs already on the same accountId should refresh.
  // `'created'` means: I just created a brand new multisig. Other tabs with no
  // multisig loaded should re-run discovery in case they're a cosigner.
  const notifyOtherTabs = useCallback((type: 'updated' | 'created', accountId: string) => {
    broadcastRef.current?.postMessage({ type, accountId });
  }, []);

  // All refreshes - manual and auto - go through this single inflight lock so
  // their setStates can never race against each other on the same account.
  // Manual refresh awaits any in-flight work; auto refresh bails entirely.
  const inflightRefreshRef = useRef<Promise<SyncResult | null> | null>(null);

  const refresh = useCallback(async (m: Multisig) => {
    if (!bundle) return null;
    // Wait for any inflight refresh (auto or manual) to finish first so the
    // setState writes are serialized. Loop because two callers awaiting the
    // same promise would both resume together and each start a new run -
    // we keep re-checking until the ref is genuinely clear.
    while (inflightRefreshRef.current) {
      try { await inflightRefreshRef.current; } catch { /* swallow */ }
    }
    const run = (async () => {
      log.debug('refresh start', { accountId: m.accountId });
      const result = await syncAll(bundle.midenClient, m, {
        guardianEndpoint: settings.guardianEndpoint,
        midenRpcEndpoint: settings.midenRpcUrl,
      });
      // If the user unloaded, switched profile or loaded a different account
      // while we were syncing, drop the result so we don't clobber the new
      // state with stale data from the previous account.
      if (multisigRef.current?.accountId !== m.accountId) {
        log.info('refresh: discarded stale result', {
          for: m.accountId,
          current: multisigRef.current?.accountId ?? null,
        });
        return result;
      }
      setProposals(result.proposals);
      setHistory(result.history);
      setNotes(result.notes);
      // Balances are derived from `state` via AccountInspector. Only refresh
      // when we have a fresh state AND the inspector succeeded - otherwise
      // keep the last-good snapshot rather than blanking Balances while the
      // rest of the card still shows values from an earlier successful sync.
      const inspectorOk = !result.errors.find((e) => e.step === 'inspector');
      if (result.state) {
        setAccountState(result.state);
        if (inspectorOk) setVaultBalances(result.vaultBalances);
      }
      const hard = result.errors.filter((e) => !isInformationalSyncError(e));
      if (hard.length) {
        const reasons = hard.map((e) => `${e.step}: ${e.message}`).join('; ');
        log.warn('refresh: partial sync', hard);
        setError(`Partial sync (${hard.length} issue(s)): ${reasons}`);
      }
      log.debug('refresh done', {
        proposals: result.proposals.length,
        history: result.history.length,
        notes: result.notes.length,
        balances: result.vaultBalances.length,
        errors: result.errors.length,
      });
      return result;
    })();
    inflightRefreshRef.current = run;
    try {
      return await run;
    } finally {
      if (inflightRefreshRef.current === run) inflightRefreshRef.current = null;
    }
  }, [bundle, settings.guardianEndpoint, settings.midenRpcUrl]);

  // Auto refresh (broadcast + visibility poll) skips entirely when something
  // else (manual sync, sign, execute, or another auto tick) is in flight.
  const autoRefresh = useCallback(async () => {
    if (inflightRefreshRef.current) return;
    if (busyKeyRef.current) return;
    const m = multisigRef.current;
    if (!m) return;
    await refresh(m);
  }, [refresh]);

  // Listen for cross-tab broadcasts. Two kinds:
  // - 'updated': a peer changed state for the same multisig we have loaded
  //   (sign, execute, propose). We refresh ours automatically.
  // - 'created': a peer created a brand-new multisig. If we don't have one
  //   loaded, run discovery for the active profile and auto-load on match.
  // Cross-machine updates are covered by the polling effect below.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('miden-multisig-sync');
    broadcastRef.current = channel;
    channel.onmessage = (ev) => {
      const data = ev.data as { type?: string; accountId?: string } | null;
      if (!data) return;
      if (data.type === 'updated') {
        const m = multisigRef.current;
        if (!m || data.accountId !== m.accountId) return;
        log.info('broadcast: peer reports update, refreshing');
        void autoRefresh();
        return;
      }
      if (data.type === 'created') {
        if (multisigRef.current) return; // already busy with something
        const profile = activeProfileRef.current;
        const b = bundleRef.current;
        if (!profile || !b) return;
        log.info('broadcast: peer reports new multisig, running discovery', { accountId: data.accountId });
        void (async () => {
          try {
            const matches = await discoverAccountsForProfile(b.multisigClient, profile);
            if (matches.length === 0) {
              log.debug('broadcast: discovery found no match for this profile');
              return;
            }
            // Prefer the broadcasted accountId if it's in the discovery
            // result; otherwise fall back to the first match.
            const target = (data.accountId && matches.includes(data.accountId)) ? data.accountId : matches[0];
            // Last-second guard: the user may have created / loaded
            // something in the brief window between discovery and load.
            if (multisigRef.current) return;
            if (activeProfileRef.current?.id !== profile.id) return;
            const m = await loadMultisig(b.multisigClient, profile, target);
            if (multisigRef.current) return;
            if (activeProfileRef.current?.id !== profile.id) return;
            setMultisig(m);
            const updated = await updateProfile(profile.id, { lastAccountId: target });
            if (updated) setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
            setStatus(`Auto-loaded ${m.accountId} (cosigner on a peer-created multisig)`);
            await refresh(m);
          } catch (e) {
            log.warn('broadcast: auto-load after create failed', (e as Error).message);
          }
        })();
        return;
      }
    };
    return () => {
      channel.close();
      if (broadcastRef.current === channel) broadcastRef.current = null;
    };
  }, [autoRefresh, refresh]);

  // Visibility-aware polling. Picks up changes from cosigners on other
  // machines (and chain progress) without the user pressing Sync. The poll
  // only fires when the tab is visible and the user is not in the middle of
  // an action.
  useEffect(() => {
    if (!multisig) return;
    const POLL_MS = 5_000;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      log.debug('auto-refresh poll');
      void autoRefresh();
    };
    const interval = window.setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [multisig, autoRefresh]);

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
      // Tell other tabs (cosigners on the same browser) that a new multisig
      // exists so they can run discovery and auto-load it.
      notifyOtherTabs('created', m.accountId);
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
    setHistory([]);
    setNotes([]);
    setVaultBalances([]);
    setAccountState(null);
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
      const result = await refresh(multisig);
      // If the user unloaded / switched account during the sync, don't
      // overwrite the new screen's status with a stale "Synced ..." message.
      if (multisigRef.current?.accountId !== multisig.accountId) return;
      if (result) {
        const STEPS = ['midenSync', 'syncState', 'syncProposals', 'notes', 'inspector'] as const;
        const okSteps = STEPS.filter((s) => !result.errors.find((e) => e.step === s));
        const hasInfo = result.errors.some(isInformationalSyncError);
        setStatus(
          `Synced. ${result.proposals.length} proposal(s), ${result.notes.length} note(s). ` +
          `(${okSteps.length}/${STEPS.length} steps ok)` +
          (hasInfo ? `. ${LOCAL_AHEAD_NOTE}` : ''),
        );
      } else {
        setStatus('Synced.');
      }
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
      if (multisigRef.current?.accountId !== multisig.accountId) return;
      setStatus(`Proposed ${p.id}`);
      await refresh(multisig);
      if (multisigRef.current?.accountId === multisig.accountId) {
        notifyOtherTabs('updated', multisig.accountId);
      }
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
      if (multisigRef.current?.accountId !== multisig.accountId) return;
      setStatus(`Signed ${proposalId}`);
      await refresh(multisig);
      if (multisigRef.current?.accountId === multisig.accountId) {
        notifyOtherTabs('updated', multisig.accountId);
      }
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
      await executeProposal(multisig, proposalId, {
        guardianEndpoint: settings.guardianEndpoint,
        midenRpcEndpoint: settings.midenRpcUrl,
      });
      if (multisigRef.current?.accountId !== multisig.accountId) return;
      setStatus(`Executed ${proposalId}`);
      await refresh(multisig);
      if (multisigRef.current?.accountId === multisig.accountId) {
        notifyOtherTabs('updated', multisig.accountId);
      }
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
            Initializing the Miden client (downloads ~4 MB of WASM the first time).
          </div>
        </div>
      ) : !multisig ? (
        <>
          {discovering && (
            <div className="mx-4 mt-3 mb-2 flex items-center gap-2 rounded border border-indigo-900/60 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
              <svg
                className="animate-spin h-3.5 w-3.5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Searching the Guardian for any multisig that involves this profile - you can create or load one already.
            </div>
          )}
          <SetupPanel
            myCommitment={activeProfile.commitment}
            guardianCommitment={bundle.guardianCommitment}
            busy={busyKey === 'create' || busyKey === 'load'}
            onCreate={handleCreateMultisig}
            onLoad={handleLoadMultisig}
          />
        </>
      ) : (
        <MultisigPanel
          multisig={multisig}
          profile={activeProfile}
          proposals={proposals}
          history={history}
          notes={notes}
          vaultBalances={vaultBalances}
          accountState={accountState}
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
