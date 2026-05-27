// Verifies the auto-reload story: after a multisig is loaded, switching profile
// away and back (and reloading the page) should NOT drop you to the Setup panel.
// Requires the dev server running at http://localhost:3002/.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const URL = 'http://localhost:3002/';
const FAUCET_API = 'https://faucet-api-devnet-miden.eu-central-8.gateway.fm';
const MINT_AMOUNT = 100;

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}

async function mintFromFaucet(accountId) {
  const powRes = await fetch(`${FAUCET_API}/pow?amount=${MINT_AMOUNT}&account_id=${encodeURIComponent(accountId)}`);
  const { challenge, target } = await powRes.json();
  const challengeBytes = Buffer.from(challenge, 'hex');
  const targetBig = BigInt(target);
  let nonce = 0n;
  while (true) {
    const buf = Buffer.alloc(8); buf.writeBigUInt64BE(nonce);
    const d = createHash('sha256').update(challengeBytes).update(buf).digest();
    if (d.readBigUInt64BE(0) < targetBig) break;
    nonce++;
  }
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: String(MINT_AMOUNT),
    challenge,
    nonce: String(nonce),
  });
  const r = await fetch(`${FAUCET_API}/get_tokens?${params}`);
  if (!r.ok) throw new Error(`/get_tokens ${r.status}`);
  return r.json();
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

async function createProfile(page, name) {
  await page.fill('input[placeholder="new profile name"]', name);
  await page.click('button:has-text("+ New profile")');
  await page.waitForFunction(
    (n) => Array.from(document.querySelectorAll('select option')).some((o) => o.textContent === n),
    name,
    { timeout: 10000 },
  );
  await page.waitForSelector('text=No multisig loaded', { timeout: 30000 });
}

async function selectProfile(page, name) {
  // The select is value-based. Find the option value by its textContent.
  const value = await page.evaluate(
    (n) => Array.from(document.querySelectorAll('select option')).find((o) => o.textContent === n)?.value ?? null,
    name,
  );
  if (!value) throw new Error(`profile ${name} not found in select`);
  await page.selectOption('select', value);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (msg) => console.log(`[browser:${msg.type()}]`, msg.text()));
page.on('pageerror', (err) => console.log('[browser:pageerror]', err.stack ?? err.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await clearStorage(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

log('main', 'create profile A and a 1-of-1 multisig…');
await createProfile(page, 'A');
await page.click('button:has-text("Create new multisig")');
await page.waitForSelector('textarea', { timeout: 5000 });
await page.locator('input[type="number"]').fill('1');  // 1-of-1 (just A)
await page.click('button:has-text("Create"):not([disabled])');
await page.waitForSelector('text=/^ID:/', { timeout: 90000 });
const accountId = await page.evaluate(() => {
  const div = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
  return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
});
log('main', 'created multisig', accountId);

// Mint + sync + propose so there is real state to lose.
log('main', 'mint…');
const m = await mintFromFaucet(accountId);
log('main', 'tx_id', m.tx_id);

log('main', 'sync until note arrives…');
let noteVisible = false;
for (let i = 0; i < 30 && !noteVisible; i++) {
  await page.click('button:has-text("Sync")');
  await page.waitForTimeout(4000);
  noteVisible = !(await page.getByText('No consumable notes.').isVisible().catch(() => true));
  if (!noteVisible) log('main', `attempt ${i + 1}: no note yet`);
}
if (!noteVisible) throw new Error('note never showed up');
log('main', 'note visible.');

// Now create a second profile B to switch to, then come back.
log('main', 'create profile B and switch away…');
await createProfile(page, 'B');
await page.waitForSelector('text=No multisig loaded', { timeout: 30000 });
log('main', 'switched to B; expected Setup panel: visible.');

log('main', 'switch back to A…');
await selectProfile(page, 'A');
// Expect the multisig to come back automatically.
await page.waitForSelector('text=/^ID:/', { timeout: 30000 });
const accountIdAfter = await page.evaluate(() => {
  const div = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
  return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
});
log('main', 'multisig auto-reloaded:', accountIdAfter);
if (accountIdAfter !== accountId) throw new Error(`account id mismatch after switch: got ${accountIdAfter}, expected ${accountId}`);

log('main', 'reload page and confirm A still has the multisig…');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
// On reload sessionStorage is cleared (its purpose); the dropdown shows both profiles
// but no active selection. Pick A again.
await selectProfile(page, 'A');
await page.waitForSelector('text=/^ID:/', { timeout: 60000 });
const accountIdReloaded = await page.evaluate(() => {
  const div = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
  return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
});
log('main', 'after reload, A loaded:', accountIdReloaded);
if (accountIdReloaded !== accountId) throw new Error('account lost after reload');

// Sanity: the note should still be there (assuming nothing on chain changed).
const stillHasNotes = !(await page.getByText('No consumable notes.').isVisible().catch(() => true));
log('main', 'note still visible after reload:', stillHasNotes);

console.log('\n✓ persistence: multisig survives profile-switch and page-reload.');
await browser.close();
