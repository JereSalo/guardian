// Full 2-of-3 end-to-end test driving the UI from 3 separate browser contexts.
// Requires:
//   - dev server running at http://localhost:3002/
//   - staging Guardian reachable via the /guardian-proxy alias
//   - a minted note will be required mid-test; the script PAUSES and prints the
//     account ID, expecting you to mint manually from https://faucet.devnet.miden.io/
//     (set MINT_AUTO=1 + implement faucet PoW in JS to remove this step later).

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const URL = process.env.URL ?? 'http://localhost:3002/';
const FAUCET_API = 'https://faucet-api-devnet-miden.eu-central-8.gateway.fm';
const MINT_AMOUNT = 100;
const NOTE_POLL_TIMEOUT_S = 240;

async function mintFromFaucet(accountId) {
  console.log(`[faucet] GET /pow`);
  const powRes = await fetch(`${FAUCET_API}/pow?amount=${MINT_AMOUNT}&account_id=${encodeURIComponent(accountId)}`);
  if (!powRes.ok) throw new Error(`/pow ${powRes.status}: ${await powRes.text()}`);
  const { challenge, target } = await powRes.json();
  const challengeBytes = Buffer.from(challenge, 'hex');
  const targetBig = BigInt(target);
  console.log(`[faucet] solving PoW (target=${target})`);
  let nonce = 0n;
  while (true) {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(nonce);
    const digest = createHash('sha256').update(challengeBytes).update(nonceBuf).digest();
    const first8 = digest.readBigUInt64BE(0);
    if (first8 < targetBig) break;
    nonce++;
  }
  console.log(`[faucet] nonce=${nonce}`);

  console.log(`[faucet] GET /get_tokens`);
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
  console.log(`[faucet] tx_id=${mint.tx_id}`);
  console.log(`[faucet] note_id=${mint.note_id}`);
}

function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
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

async function openTab(browser, name) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[${name}:${msg.type()}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => console.log(`[${name}:pageerror]`, err.stack ?? err.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await clearStorage(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  return { context, page };
}

async function createProfile(page, name) {
  await page.fill('input[placeholder="new profile name"]', name);
  await page.click('button:has-text("+ New profile")');
  // <option> inside <select> is hidden in DOM; check via evaluate instead.
  await page.waitForFunction((n) => {
    const opts = Array.from(document.querySelectorAll('select option'));
    return opts.some((o) => o.textContent === n);
  }, name, { timeout: 10000 });
  // Wait for the bundle init (Setup panel visible)
  await page.waitForSelector('text=No multisig loaded', { timeout: 30000 });
  // Extract the short commitment from the profile bar via DOM eval (more
  // resilient than a class-based locator, which broke when the bar markup
  // moved font-mono onto the wrapping button).
  const actualCommitment = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const s = spans.find((el) => el.textContent && el.textContent.includes('commitment:'));
    return s ? s.textContent : null;
  });
  log(name, 'profile created, bar text:', actualCommitment);
  return actualCommitment;
}

async function getMyCommitmentFull(page) {
  // Trigger the setup form to see the full commitment.
  await page.click('button:has-text("Create new multisig")');
  await page.waitForSelector('text=Your commitment:', { timeout: 5000 });
  const full = await page.evaluate(() => {
    const div = Array.from(document.querySelectorAll('div')).find((el) =>
      el.textContent && el.textContent.startsWith('Your commitment:')
    );
    if (!div) return null;
    const span = div.querySelector('span.font-mono');
    return span ? span.textContent.trim() : null;
  });
  return full;
}

async function cancelSetup(page) {
  await page.click('button:has-text("Cancel")');
  await page.waitForSelector('text=No multisig loaded', { timeout: 5000 });
}

const browser = await chromium.launch({ headless: true, ignoreHTTPSErrors: true });

const a = await openTab(browser, 'A');
const b = await openTab(browser, 'B');
const c = await openTab(browser, 'C');

log('main', 'Creating 3 profiles in parallel…');
await Promise.all([
  createProfile(a.page, 'A'),
  createProfile(b.page, 'B'),
  createProfile(c.page, 'C'),
]);

log('main', 'Reading full commitments…');
const aCommit = await getMyCommitmentFull(a.page);
await cancelSetup(a.page);
const bCommit = await getMyCommitmentFull(b.page);
await cancelSetup(b.page);
const cCommit = await getMyCommitmentFull(c.page);
await cancelSetup(c.page);
log('main', 'A:', aCommit);
log('main', 'B:', bCommit);
log('main', 'C:', cCommit);

log('A', 'Opening Create multisig…');
await a.page.click('button:has-text("Create new multisig")');
await a.page.waitForSelector('textarea', { timeout: 5000 });
await a.page.fill('textarea', `${bCommit}\n${cCommit}`);
const thresholdInput = a.page.locator('input[type="number"]');
await thresholdInput.fill('2');
log('A', 'Clicking Create…');
await a.page.click('button:has-text("Create"):not([disabled])');
// Wait for the dashboard to appear with the account ID
await a.page.waitForSelector('text=/^ID:/', { timeout: 90000 });
const accountId = await a.page.evaluate(() => {
  const idLine = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
  if (!idLine) return null;
  const span = idLine.querySelector('span.font-mono');
  return span?.textContent?.trim() ?? null;
});
log('A', 'Account ID:', accountId);

log('B,C', 'Loading existing multisig…');
async function loadOn(page, label) {
  await page.click('button:has-text("Load existing")');
  await page.waitForSelector('input[placeholder="0x..."]', { timeout: 5000 });
  await page.fill('input[placeholder="0x..."]', accountId);
  await page.click('button:has-text("Load"):not([disabled])');
  await page.waitForSelector('text=/^ID:/', { timeout: 30000 });
  log(label, 'loaded');
}
await loadOn(b.page, 'B');
await loadOn(c.page, 'C');

log('faucet', 'Minting…');
await mintFromFaucet(accountId);

log('A', `Polling Sync up to ${NOTE_POLL_TIMEOUT_S}s…`);
const deadline = Date.now() + NOTE_POLL_TIMEOUT_S * 1000;
let foundNote = false;
while (Date.now() < deadline) {
  await a.page.click('button:has-text("Sync")');
  await a.page.waitForTimeout(500);
  // Wait until Sync button is enabled again
  await a.page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => x.textContent?.startsWith('Sync'));
    return b && !b.disabled;
  }, { timeout: 30000 });
  const empty = await a.page.getByText('No consumable notes.').isVisible().catch(() => false);
  if (!empty) {
    foundNote = true;
    break;
  }
  log('A', 'no note yet, sleeping 8s');
  await a.page.waitForTimeout(8000);
}
if (!foundNote) {
  console.error('Note never appeared. Aborting.');
  await browser.close();
  process.exit(1);
}
log('A', 'Note(s) present.');

async function clickAndAwaitStatus(page, label, buttonText, expectStatusPrefix, timeoutMs = 90000) {
  await page.click(`button:has-text("${buttonText}"):not([disabled])`);
  await page.waitForFunction(
    (prefix) => {
      const spans = Array.from(document.querySelectorAll('span.text-zinc-400'));
      return spans.some((s) => s.textContent?.startsWith(prefix));
    },
    expectStatusPrefix,
    { timeout: timeoutMs },
  );
  const status = await page.evaluate((prefix) => {
    const spans = Array.from(document.querySelectorAll('span.text-zinc-400'));
    return spans.find((s) => s.textContent?.startsWith(prefix))?.textContent ?? '';
  }, expectStatusPrefix);
  log(label, status);
}

log('A', 'Selecting note and proposing ConsumeNotes…');
const checkboxes = a.page.locator('input[type="checkbox"]');
await checkboxes.first().check();
await clickAndAwaitStatus(a.page, 'A', 'Propose ConsumeNotes', 'Proposed ', 90000);

// The WASM TS client does NOT auto-sign the proposer (unlike the Rust client).
// The proposer must call sign explicitly to contribute their signature.
log('A', 'Signing own proposal (proposer is not auto-signed in TS client)…');
await clickAndAwaitStatus(a.page, 'A', 'Sign', 'Signed ', 60000);

log('B', 'Sync + Sign…');
await clickAndAwaitStatus(b.page, 'B', 'Sync', 'Synced.', 90000);
await b.page.waitForSelector('button:has-text("Sign"):not([disabled])', { timeout: 30000 });
await clickAndAwaitStatus(b.page, 'B', 'Sign', 'Signed ', 90000);

log('C', 'Sync + Execute…');
await clickAndAwaitStatus(c.page, 'C', 'Sync', 'Synced.', 90000);
await c.page.waitForSelector('button:has-text("Execute"):not([disabled])', { timeout: 30000 });
await clickAndAwaitStatus(c.page, 'C', 'Execute', 'Executed ', 180000);

// After the Execute, validate the three new UI sections: Balances, History
// and Account commitment / Last synced. Guardian canonicalization runs every
// ~10s, so right after Execute the Balances may still be empty (Guardian
// hasn't picked up the new on-chain state yet). We retry the Sync up to
// ~90s with a small backoff to give canonicalization time to land.
async function readNewSections(page, label, { requireHistory }) {
  const SECTION_POLL_TIMEOUT_S = 90;
  const deadline = Date.now() + SECTION_POLL_TIMEOUT_S * 1000;
  let lastErrors = [];
  let lastSections = null;
  while (Date.now() < deadline) {
    await page.click('button:has-text("Sync"):not([disabled])');
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const s = btns.find((x) => x.textContent?.startsWith('Sync'));
      return s && !s.disabled;
    }, { timeout: 60000 });

    const sections = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h3'));
      const findSection = (title) =>
        headings.find((h) => h.textContent?.trim() === title)?.parentElement ?? null;
      const balancesSection = findSection('Balances');
      const historySection = findSection('History');
      const accountCard = document.querySelector('section');

      const balancesText = balancesSection ? balancesSection.innerText : null;
      const historyText = historySection ? historySection.innerText : null;
      const accountCardText = accountCard ? accountCard.innerText : null;

      return {
        hasBalancesSection: !!balancesSection,
        hasHistorySection: !!historySection,
        balancesText,
        historyText,
        hasAccountCommitment: !!accountCardText?.includes('Account commitment:'),
        hasLastSynced: !!accountCardText?.includes('Last synced:'),
      };
    });
    lastSections = sections;

    const errors = [];
    if (!sections.hasBalancesSection) errors.push('Balances section missing');
    if (!sections.hasHistorySection) errors.push('History section missing');
    if (!sections.hasAccountCommitment) errors.push('Account commitment line missing');
    if (!sections.hasLastSynced) errors.push('Last synced line missing');
    if (sections.balancesText && sections.balancesText.includes('No vault balances yet')) {
      errors.push(`Balances still empty: ${sections.balancesText.replace(/\s+/g, ' ')}`);
    }
    // Only the executor has a reliable local "finalized" entry. For other
    // tabs the SDK's syncProposals quietly skips updating the local status
    // (verifyProposalMetadataBinding fails on the post-finalization proposal),
    // so they would assert forever. We only require History to be populated
    // on the executor tab.
    if (requireHistory && sections.historyText && sections.historyText.includes('No finalized proposals yet')) {
      errors.push(`History still empty: ${sections.historyText.replace(/\s+/g, ' ')}`);
    }
    lastErrors = errors;
    if (errors.length === 0) {
      log(label, 'sections OK:', JSON.stringify({
        balances: sections.balancesText?.replace(/\s+/g, ' '),
        history: sections.historyText?.replace(/\s+/g, ' ').slice(0, 80) + '…',
      }));
      return true;
    }
    log(label, `assertions not yet ok (${errors.length} pending), retrying in 8s…`);
    await page.waitForTimeout(8000);
  }
  console.error(`[${label}] new-section assertions FAILED after ${SECTION_POLL_TIMEOUT_S}s:`);
  for (const e of lastErrors) console.error('  -', e);
  if (lastSections) console.error(`[${label}] last seen:`, JSON.stringify(lastSections, null, 2));
  return false;
}

log('main', 'Asserting new sections (Balances / History / account meta)…');
// Only the executor (C) has a reliably finalized local proposal entry.
const okA = await readNewSections(a.page, 'A', { requireHistory: false });
const okB = await readNewSections(b.page, 'B', { requireHistory: false });
const okC = await readNewSections(c.page, 'C', { requireHistory: true });

if (!okA || !okB || !okC) {
  console.error('\n✗ New-section assertions failed.');
  await browser.close();
  process.exit(1);
}

console.log('\n✓ Full 2-of-3 flow succeeded end-to-end (including new Balances / History / account meta sections).');
await browser.close();
