// Display-only cache of finalized proposals.
//
// Why this exists: the SDK's `Multisig.proposals` Map is in-memory (see
// packages/miden-multisig-client/src/multisig.ts). After a refresh, a freshly
// instantiated Multisig has an empty map. `syncProposals({skipInvalid: true})`
// silently drops finalized deltas (their tx_summary cannot be reconstructed
// post-finalization, so `verifyProposalMetadataBinding` rejects them), so
// `listProposals()` never repopulates the history. The History UI then shows
// "No finalized proposals yet." even though the user executed proposals in
// the previous session.
//
// This cache is a per-browser localStorage record written when a proposal
// finalizes locally (i.e. when the user clicks Execute and the SDK's submit
// succeeds). It is read-only for display purposes; never use it for signing,
// execution, or any SDK state recovery.
//
// Keyed by guardianEndpoint + midenRpcEndpoint + accountId so entries don't
// collide across networks / staging environments.

import type { Proposal } from '@openzeppelin/miden-multisig-client';
import { logger } from './log';

const log = logger('historyCache');

const CACHE_VERSION = 1;
const STORAGE_KEY_PREFIX = `web-tester-history-v${CACHE_VERSION}`;

function storageKey(guardianEndpoint: string, midenRpcEndpoint: string, accountId: string): string {
  return [STORAGE_KEY_PREFIX, guardianEndpoint, midenRpcEndpoint, accountId.toLowerCase()].join('|');
}

/**
 * Validate the minimum shape the History UI touches. A malformed entry from
 * an older storage version would otherwise blow up either `mergeHistory` on
 * `.toLowerCase()` or `describeProposal` on `metadata.proposalType`.
 * Status must be exactly 'finalized' - this cache only holds finalized
 * proposals, anything else is corruption.
 */
function isValidProposalEntry(value: unknown): value is Proposal {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string') return false;
  if (typeof obj.nonce !== 'number') return false;
  if (obj.status !== 'finalized') return false;
  if (!obj.metadata || typeof obj.metadata !== 'object') return false;
  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.proposalType !== 'string') return false;
  return true;
}

export function loadCachedHistory(
  guardianEndpoint: string,
  midenRpcEndpoint: string,
  accountId: string,
): Proposal[] {
  try {
    const raw = localStorage.getItem(storageKey(guardianEndpoint, midenRpcEndpoint, accountId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidProposalEntry);
  } catch (e) {
    log.warn('loadCachedHistory failed', (e as Error).message);
    return [];
  }
}

/**
 * Drop cached entries whose id matches `ghostIds`. Not wired into syncAll
 * (eviction based on syncProposals output would race against the SDK's
 * in-memory map and could drop valid history). Reserved for an explicit
 * reset path - e.g. a future "Clear history" button.
 */
export function evictCachedHistory(
  guardianEndpoint: string,
  midenRpcEndpoint: string,
  accountId: string,
  ghostIds: Iterable<string>,
): void {
  const ghosts = new Set(Array.from(ghostIds, (id) => id.toLowerCase()));
  if (ghosts.size === 0) return;
  try {
    const existing = loadCachedHistory(guardianEndpoint, midenRpcEndpoint, accountId);
    const kept = existing.filter((p) => !ghosts.has(p.id.toLowerCase()));
    if (kept.length === existing.length) return;
    localStorage.setItem(
      storageKey(guardianEndpoint, midenRpcEndpoint, accountId),
      JSON.stringify(kept),
    );
    log.info('evicted ghost history entries', { removed: existing.length - kept.length });
  } catch (e) {
    log.warn('evictCachedHistory failed', (e as Error).message);
  }
}

export function cacheFinalizedProposal(
  guardianEndpoint: string,
  midenRpcEndpoint: string,
  accountId: string,
  proposal: Proposal,
): void {
  if (proposal.status !== 'finalized') return;
  try {
    const existing = loadCachedHistory(guardianEndpoint, midenRpcEndpoint, accountId);
    const idLower = proposal.id.toLowerCase();
    const filtered = existing.filter((p) => p.id.toLowerCase() !== idLower);
    const next = [...filtered, proposal];
    localStorage.setItem(
      storageKey(guardianEndpoint, midenRpcEndpoint, accountId),
      JSON.stringify(next),
    );
    log.debug('cached finalized proposal', { id: proposal.id, total: next.length });
  } catch (e) {
    // localStorage may throw QuotaExceededError. Non-fatal for display-only cache.
    log.warn('cacheFinalizedProposal failed', (e as Error).message);
  }
}

/**
 * Merge cached finalized proposals with live ones from the SDK. The live one
 * wins on duplicate id (it has the freshest signatures). Result is sorted
 * newest first via descending nonce.
 */
export function mergeHistory(cached: Proposal[], live: Proposal[]): Proposal[] {
  const byId = new Map<string, Proposal>();
  for (const p of cached) byId.set(p.id.toLowerCase(), p);
  for (const p of live) byId.set(p.id.toLowerCase(), p);
  return Array.from(byId.values()).sort((a, b) => b.nonce - a.nonce);
}
