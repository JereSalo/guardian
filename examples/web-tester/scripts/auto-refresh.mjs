// Validates the BroadcastChannel auto-refresh path: two pages in the SAME
// browser context, both watching the same multisig. When tab A signs a
// proposal, tab B should pick up the new signature WITHOUT clicking Sync.
//
// Reuses the e2e helpers (createProfile, getMyCommitmentFull) by inlining
// the minimal subset we need. Requires:
//   - a reachable deployment (URL env var, defaults to localhost dev)
//   - a minted note (will mint via the devnet faucet, same as e2e.mjs)

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const URL = process.env.URL ?? 'http://localhost:3002/';
const FAUCET_API = 'https://faucet-api-devnet-miden.eu-central-8.gateway.fm';
const MINT_AMOUNT = 100;
const NOTE_POLL_TIMEOUT_S = 240;

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

async function mintFromFaucet(accountId) {
  log('faucet', 'GET /pow');
  const powRes = await fetch(`${FAUCET_API}/pow?amount=${MINT_AMOUNT}&account_id=${encodeURIComponent(accountId)}`);
  if (!powRes.ok) throw new Error(`/pow ${powRes.status}: ${await powRes.text()}`);
  const { challenge, target } = await powRes.json();
  const challengeBytes = Buffer.from(challenge, 'hex');
  const targetBig = BigInt(target);
  log('faucet', `solving PoW (target=${target})`);
  let nonce = 0n;
  while (true) {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(nonce);
    const digest = createHash('sha256').update(challengeBytes).update(nonceBuf).digest();
    if (digest.readBigUInt64BE(0) < targetBig) break;
    nonce++;
  }
  log('faucet', `nonce=${nonce}`);

  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: String(MINT_AMOUNT),
    challenge,
    nonce: String(nonce),
  });
  const mintRes = await fetch(`${FAUCET_API}/get_tokens?${params}`);
  if (!mintRes.ok) throw new Error(`/get_tokens ${mintRes.status}: ${await mintRes.text()}`);
  const mint = await mintRes.json();
  log('faucet', `tx_id=${mint.tx_id} note_id=${mint.note_id}`);
}

async function clearStorage(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((db) => new Promise((res) => {
      if (!db.name) return res();
      const r = indexedDB.deleteDatabase(db.name);
      r.onsuccess = () => res();
      r.onerror = () => res();
      r.onblocked = () => res();
    })));
  });
}

async function openPage(context, name) {
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[${name}:${msg.type()}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => console.log(`[${name}:pageerror]`, err.stack ?? err.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  return page;
}

async function createProfile(page, name, label) {
  await page.fill('input[placeholder="new profile name"]', name);
  await page.click('button:has-text("+ New profile")');
  await page.waitForFunction((n) => {
    const opts = Array.from(document.querySelectorAll('select option'));
    return opts.some((o) => o.textContent === n);
  }, name, { timeout: 15000 });
  await page.waitForSelector('text=No multisig loaded', { timeout: 30000 });
  log(label, `profile "${name}" created`);
}

async function getMyCommitmentFull(page) {
  await page.click('button:has-text("Create new multisig")');
  await page.waitForSelector('text=Your commitment:', { timeout: 5000 });
  const full = await page.evaluate(() => {
    const div = Array.from(document.querySelectorAll('div')).find((el) =>
      el.textContent && el.textContent.startsWith('Your commitment:')
    );
    return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
  });
  await page.click('button:has-text("Cancel")');
  await page.waitForSelector('text=No multisig loaded', { timeout: 5000 });
  return full;
}

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });

// Two pages in the SAME context so BroadcastChannel works between them.
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const pageA = await openPage(context, 'A');
await clearStorage(pageA);
await pageA.reload({ waitUntil: 'networkidle' });

// We need a 2-of-2 multisig so a proposal goes through the propose-sign-execute
// flow with broadcast between tabs. The two profiles live in the same context
// (one IndexedDB) - we'll create them by switching the profile dropdown.
log('A', 'Creating two profiles (X and Y) in the same context…');
await createProfile(pageA, 'X', 'A');
const commitmentX = await getMyCommitmentFull(pageA);
log('A', 'commitmentX:', commitmentX);

await createProfile(pageA, 'Y', 'A');
const commitmentY = await getMyCommitmentFull(pageA);
log('A', 'commitmentY:', commitmentY);

// Now the active profile is Y (last created). Open a second page in the same
// context: it will share IndexedDB and BroadcastChannel.
const pageB = await openPage(context, 'B');
// Switch B to profile X. A stays on Y.
log('B', 'Switching profile to X…');
await pageB.selectOption('select', { label: 'X' });
await pageB.waitForSelector('text=No multisig loaded', { timeout: 30000 });

// On A (profile Y), create a 1-of-2 multisig with cosigner = X.
// We use 1-of-2 so a single Sign is enough to make it Ready -> tab B should
// learn about that signature via broadcast, with no manual Sync.
log('A', 'Creating 1-of-2 multisig with cosigner = X…');
await pageA.click('button:has-text("Create new multisig")');
await pageA.waitForSelector('textarea', { timeout: 5000 });
await pageA.fill('textarea', commitmentX);
await pageA.locator('input[type="number"]').fill('1');
await pageA.click('button:has-text("Create"):not([disabled])');
await pageA.waitForSelector('text=/^ID:/', { timeout: 120000 });
const accountId = await pageA.evaluate(() => {
  const idLine = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
  return idLine?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
});
log('A', 'Account ID:', accountId);

// Load that multisig on B (profile X).
log('B', `Loading ${accountId}…`);
await pageB.click('button:has-text("Load existing")');
await pageB.waitForSelector('input[placeholder="0x..."]', { timeout: 5000 });
await pageB.fill('input[placeholder="0x..."]', accountId);
await pageB.click('button:has-text("Load"):not([disabled])');
await pageB.waitForSelector('text=/^ID:/', { timeout: 60000 });
log('B', 'loaded');

// Mint a note to the multisig account.
log('faucet', 'Minting…');
await mintFromFaucet(accountId);

// On A, poll Sync until the note appears.
log('A', `Polling Sync up to ${NOTE_POLL_TIMEOUT_S}s for minted note…`);
const deadline = Date.now() + NOTE_POLL_TIMEOUT_S * 1000;
let foundNote = false;
while (Date.now() < deadline) {
  await pageA.click('button:has-text("Sync"):not([disabled])');
  await pageA.waitForTimeout(500);
  await pageA.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => x.textContent?.startsWith('Sync'));
    return b && !b.disabled;
  }, { timeout: 30000 });
  if (!(await pageA.getByText('No consumable notes.').isVisible().catch(() => false))) {
    foundNote = true;
    break;
  }
  log('A', 'no note yet, sleeping 8s');
  await pageA.waitForTimeout(8000);
}
if (!foundNote) {
  console.error('Note never appeared. Aborting.');
  await browser.close();
  process.exit(1);
}

// A proposes consume. After it succeeds, A's success handler broadcasts. B
// should refresh on its own (no manual Sync) and show the proposal.
log('A', 'Proposing consume on A…');
await pageA.locator('input[type="checkbox"]').first().check();
await pageA.click('button:has-text("Propose ConsumeNotes"):not([disabled])');
// Wait for A status "Proposed ".
await pageA.waitForFunction(() => {
  const spans = Array.from(document.querySelectorAll('span.text-zinc-400'));
  return spans.some((s) => s.textContent?.startsWith('Proposed '));
}, { timeout: 120000 });
log('A', 'A says: proposed');

// Now wait for B (which should NOT have been manually synced) to show the
// proposal entry via broadcast. We give it up to 10s - broadcast is essentially
// instant; we just need React to render after the refresh.
log('B', 'Waiting for proposal to appear on B without manual Sync (BroadcastChannel)…');
const broadcastDeadline = Date.now() + 10_000;
let bSawProposal = false;
while (Date.now() < broadcastDeadline) {
  const text = await pageB.locator('text=Pending proposals').isVisible().catch(() => false);
  if (text) {
    const noPending = await pageB.getByText('No pending proposals.').isVisible().catch(() => false);
    if (!noPending) {
      bSawProposal = true;
      break;
    }
  }
  await pageB.waitForTimeout(500);
}

if (!bSawProposal) {
  console.error('\n✗ BroadcastChannel auto-refresh FAILED: B did not see the proposal within 10s.');
  await browser.close();
  process.exit(1);
}
log('B', '✓ saw the proposal via broadcast (no manual Sync)');

// As a bonus check: tab B signs. A should receive a broadcast and see the
// signature within a few seconds without manual Sync.
log('B', 'Signing on B…');
await pageB.click('button:has-text("Sign"):not([disabled])');
await pageB.waitForFunction(() => {
  const spans = Array.from(document.querySelectorAll('span.text-zinc-400'));
  return spans.some((s) => s.textContent?.startsWith('Signed '));
}, { timeout: 120000 });
log('B', 'B says: signed');

log('A', 'Waiting for A to show the new signature without manual Sync…');
const aDeadline = Date.now() + 10_000;
let aSawSig = false;
while (Date.now() < aDeadline) {
  // After B signs, A's proposal card should show 1/1 READY (since the multisig
  // is 1-of-2 with B as the signer).
  const ready = await pageA.evaluate(() => {
    const txt = document.body.innerText;
    return /READY/.test(txt);
  });
  if (ready) {
    aSawSig = true;
    break;
  }
  await pageA.waitForTimeout(500);
}

if (!aSawSig) {
  console.error('\n✗ BroadcastChannel auto-refresh FAILED on reverse direction: A did not see the signature within 10s.');
  await browser.close();
  process.exit(1);
}
log('A', '✓ saw the signature via broadcast (no manual Sync)');

console.log('\n✓ BroadcastChannel auto-refresh works in both directions.');
await browser.close();
