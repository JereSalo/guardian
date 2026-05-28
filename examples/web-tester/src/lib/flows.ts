import { MidenClient, Word } from '@miden-sdk/miden-sdk';
import {
  AccountInspector,
  MultisigClient,
  type Multisig,
  type Proposal,
  type ConsumableNote,
  type AccountState,
  type VaultBalance,
} from '@openzeppelin/miden-multisig-client';
import { makeSignerFromProfile, type ProfileRecord } from './profiles';
import { logger } from './log';
import { cacheFinalizedProposal, loadCachedHistory, mergeHistory } from './historyCache';

const log = logger('flows');

export async function createMidenClient(rpcUrl: string, storeName: string): Promise<MidenClient> {
  log.info('createMidenClient', { rpcUrl, storeName });
  const normalized = rpcUrl.trim().toLowerCase();
  if (normalized === 'devnet' || normalized === 'https://rpc.devnet.miden.io') {
    return MidenClient.createDevnet({ rpcUrl, storeName });
  }
  if (normalized === 'testnet' || normalized === 'https://rpc.testnet.miden.io') {
    return MidenClient.createTestnet({ rpcUrl, storeName });
  }
  return MidenClient.create({ rpcUrl, storeName, autoSync: true });
}

export async function initMultisigClient(
  midenClient: MidenClient,
  guardianEndpoint: string,
  midenRpcEndpoint: string,
): Promise<{ client: MultisigClient; guardianCommitment: string }> {
  log.info('initMultisigClient', { guardianEndpoint, midenRpcEndpoint });
  const client = new MultisigClient(midenClient, { guardianEndpoint, midenRpcEndpoint });
  const response = await client.guardianClient.getPubkey();
  const guardianCommitment = typeof response === 'string' ? response : response.commitment;
  log.info('initMultisigClient ready', { guardianCommitment: guardianCommitment.slice(0, 16) + '…' });
  return { client, guardianCommitment };
}

export async function createMultisig(
  client: MultisigClient,
  profile: ProfileRecord,
  otherCommitments: string[],
  threshold: number,
  guardianCommitment: string,
): Promise<Multisig> {
  log.info('createMultisig', {
    threshold,
    totalCosigners: 1 + otherCommitments.length,
    myCommitment: profile.commitment.slice(0, 12) + '…',
  });
  const signer = makeSignerFromProfile(profile);
  const signerCommitments = [signer.commitment, ...otherCommitments];
  const multisig = await client.create(
    {
      threshold,
      signerCommitments,
      guardianCommitment,
      guardianEnabled: true,
      storageMode: 'private',
      signatureScheme: 'falcon',
    },
    signer,
  );
  log.info('created multisig, registering on guardian', { accountId: multisig.accountId });
  await multisig.registerOnGuardian();
  log.info('registered on guardian', { accountId: multisig.accountId });
  return multisig;
}

export async function loadMultisig(
  client: MultisigClient,
  profile: ProfileRecord,
  accountId: string,
): Promise<Multisig> {
  log.info('loadMultisig', { accountId, profile: profile.name });
  const signer = makeSignerFromProfile(profile);
  const m = await client.load(accountId, signer);
  log.info('loaded multisig', { accountId: m.accountId, threshold: m.threshold, signers: m.signerCommitments.length });
  return m;
}

export type SyncResult = {
  state: AccountState | null;
  proposals: Proposal[];
  /** Finalized proposals, newest first - shown as History in the UI. */
  history: Proposal[];
  notes: ConsumableNote[];
  /** Vault fungible balances derived from the latest AccountState via AccountInspector. */
  vaultBalances: VaultBalance[];
  /** Per-step soft errors. Caller can show them without dropping the loaded multisig. */
  errors: {
    step: 'midenSync' | 'syncState' | 'syncProposals' | 'notes' | 'inspector';
    message: string;
  }[];
};

/**
 * Best-effort sync: runs every step independently so one failure (e.g. a stale
 * proposal whose tx_summary no longer reconstructs cleanly via
 * `verifyProposalMetadataBinding`) does not destroy the rest of the result.
 * Falls back to `multisig.listProposals()` when the streaming sync fails so the
 * UI can still render whatever was previously cached.
 */
export async function syncAll(
  midenClient: MidenClient,
  multisig: Multisig,
  cacheKeys?: { guardianEndpoint: string; midenRpcEndpoint: string },
): Promise<SyncResult> {
  const errors: SyncResult['errors'] = [];

  log.debug('sync: midenClient.sync()');
  try {
    await midenClient.sync();
  } catch (e) {
    const msg = (e as Error).message;
    log.warn('midenClient.sync failed', msg);
    errors.push({ step: 'midenSync', message: msg });
  }

  log.debug('sync: multisig.syncState()');
  let state: AccountState | null = null;
  try {
    state = await multisig.syncState();
  } catch (e) {
    const msg = (e as Error).message;
    log.warn('syncState failed', msg);
    errors.push({ step: 'syncState', message: msg });
  }

  log.debug('sync: multisig.syncProposals({ skipInvalid: true })');
  let streamed: Proposal[];
  try {
    // `skipInvalid` keeps the batch alive when a single proposal fails
    // verifyProposalMetadataBinding (e.g. corrupted metadata from an older
    // run on the same account). The SDK logs each skip via console.warn.
    streamed = await multisig.syncProposals({ skipInvalid: true });
  } catch (e) {
    const msg = (e as Error).message;
    log.warn('syncProposals failed; falling back to listProposals', msg);
    errors.push({ step: 'syncProposals', message: msg });
    streamed = multisig.listProposals();
  }
  // History sources, merged:
  //   1. Local SDK state (`multisig.listProposals()`): proposals finalized in
  //      this in-memory instance (i.e. executed during this session).
  //   2. Persistent localStorage cache (`historyCache`): proposals previously
  //      finalized by this browser. Survives refresh.
  // SDK's `proposals` is wiped on every page load (Map() in memory), and
  // `syncProposals({skipInvalid:true})` deliberately drops finalized deltas
  // (their tx_summary cannot be reconstructed post-finalization), so without
  // the cache the History section goes empty after refresh.
  const live = multisig.listProposals().filter((p) => p.status === 'finalized');
  // We intentionally do NOT evict cached entries based on the non-finalized
  // proposals in this batch. `syncProposals` returns the SDK's full in-memory
  // map (streamed + leftover), so a stale pending object from before another
  // tab's execute would look like "ghost reappearance" and incorrectly evict
  // a valid cached finalized entry. Display history is intentionally additive;
  // the cache is per-browser and ghost-from-rollback scenarios are extremely
  // rare in practice. See `evictCachedHistory` for an explicit-reset hook.
  const cached = cacheKeys
    ? loadCachedHistory(cacheKeys.guardianEndpoint, cacheKeys.midenRpcEndpoint, multisig.accountId)
    : [];
  const history = mergeHistory(cached, live);
  // Filter out proposals that are already in history. Cross-tab scenario:
  // tab B executes a proposal and caches it as finalized in localStorage. Tab
  // A still has the proposal as 'ready' in its in-memory map because
  // syncProposals({skipInvalid:true}) silently drops the finalization delta
  // (verifyProposalMetadataBinding cannot reconstruct tx_summary post-
  // finalization). Without this filter, tab A would show the same proposal in
  // both Pending and History after the broadcast refresh.
  const finalizedIds = new Set(history.map((p) => p.id.toLowerCase()));
  const proposals = streamed.filter(
    (p) => p.status !== 'finalized' && !finalizedIds.has(p.id.toLowerCase()),
  );

  log.debug('sync: multisig.getConsumableNotes()');
  let notes: ConsumableNote[] = [];
  try {
    notes = await multisig.getConsumableNotes();
  } catch (e) {
    const msg = (e as Error).message;
    log.warn('getConsumableNotes failed', msg);
    errors.push({ step: 'notes', message: msg });
  }

  // Vault balances are derived from the most recent successful state fetch.
  // If syncState failed we leave vaultBalances empty rather than surfacing a
  // separate error - the syncState error already signals that the snapshot is
  // stale.
  let vaultBalances: VaultBalance[] = [];
  if (state) {
    try {
      vaultBalances = AccountInspector.fromBase64(state.stateDataBase64).vaultBalances;
    } catch (e) {
      const msg = (e as Error).message;
      log.warn('AccountInspector failed', msg);
      errors.push({ step: 'inspector', message: msg });
    }
  }

  log.info('sync result', {
    proposals: proposals.length,
    history: history.length,
    notes: notes.length,
    balances: vaultBalances.length,
    errors: errors.length,
  });
  return { state, proposals, history, notes, vaultBalances, errors };
}

export async function proposeConsumeNotes(multisig: Multisig, noteIds: string[]): Promise<Proposal> {
  log.info('proposeConsumeNotes', { noteIds: noteIds.map((id) => id.slice(0, 14) + '…') });
  const p = await multisig.createConsumeNotesProposal(noteIds);
  log.info('proposeConsumeNotes done', { id: p.id, status: p.status, sigs: p.signatures.length });
  return p;
}

export async function signProposal(multisig: Multisig, proposalId: string): Promise<Proposal> {
  log.info('signProposal', { proposalId });
  const p = await multisig.signProposal(proposalId);
  log.info('signProposal done', { id: p.id, status: p.status, sigs: p.signatures.length });
  return p;
}

export async function executeProposal(
  multisig: Multisig,
  proposalId: string,
  cacheKeys?: { guardianEndpoint: string; midenRpcEndpoint: string },
): Promise<void> {
  log.info('executeProposal', { proposalId });
  await multisig.executeProposal(proposalId);
  log.info('executeProposal done', { proposalId });
  // The SDK sets `status = 'finalized'` on the in-memory proposal after
  // submit succeeds. Snapshot it into the localStorage cache so the History
  // section still renders it after a page refresh (the SDK's proposals map
  // does not survive a refresh - see lib/historyCache.ts).
  if (cacheKeys) {
    const idLower = proposalId.toLowerCase();
    const finalized = multisig
      .listProposals()
      .find((p) => p.id.toLowerCase() === idLower && p.status === 'finalized');
    if (finalized) {
      cacheFinalizedProposal(
        cacheKeys.guardianEndpoint,
        cacheKeys.midenRpcEndpoint,
        multisig.accountId,
        finalized,
      );
    } else {
      log.warn('executeProposal: finalized proposal not found in listProposals; cache skipped', { proposalId });
    }
  }
}

/**
 * Discovers which Guardian-side multisig accounts authorize this profile's
 * commitment. Used to auto-load the multisig for a profile that was only ever
 * added as a cosigner (never called Create/Load locally, so `lastAccountId`
 * is empty).
 */
export async function discoverAccountsForProfile(
  client: MultisigClient,
  profile: ProfileRecord,
): Promise<string[]> {
  log.info('discoverAccountsForProfile', { profile: profile.name });
  const signer = makeSignerFromProfile(profile);
  const matches = await client.recoverByKey(signer);
  const ids = matches.map((m) => m.accountId);
  log.info('discoverAccountsForProfile result', { profile: profile.name, count: ids.length, ids });
  return ids;
}

/**
 * Frees the signer-key → account binding in the per-profile miden-client
 * keystore. Lets the user create or load a different multisig with the same
 * profile (the SDK's FalconSigner.bindAccountKey enforces 1 key → 1 account
 * locally; see signers/falcon.ts).
 *
 * Caller is responsible for any UI state cleanup (lastAccountId, multisig ref).
 */
export async function unbindAccountKey(midenClient: MidenClient, commitmentHex: string): Promise<void> {
  log.info('unbindAccountKey', { commitment: commitmentHex.slice(0, 14) + '…' });
  try {
    await midenClient.keystore.remove(Word.fromHex(commitmentHex));
    log.info('unbindAccountKey done');
  } catch (e) {
    log.warn('unbindAccountKey failed (may be already absent)', (e as Error).message);
  }
}
