// Verifies that switching to a profile that is ONLY a cosigner (never called
// Create/Load locally) still auto-loads its multisig via Guardian's
// recoverByKey lookup.
//
// Setup:
//   - Profile A creates a 2-of-2 multisig that includes B's commitment.
//   - We never call Create/Load from B (so B.lastAccountId stays empty).
//   - Switch to B. Expect: B auto-loads the multisig.

import { chromium } from 'playwright';

const URL = 'http://localhost:3002/';
const log = (...a) => console.log('[auto-discover]', ...a);

async function clearStorage(page) {
  await page.evaluate(async () => {
    localStorage.clear(); sessionStorage.clear();
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((db) => new Promise((res) => {
      if (!db.name) return res();
      const r = indexedDB.deleteDatabase(db.name);
      r.onsuccess = () => res(); r.onerror = () => res(); r.onblocked = () => res();
    })));
  });
}

async function createProfile(page, name) {
  await page.fill('input[placeholder="new profile name"]', name);
  await page.click('button:has-text("+ New profile")');
  await page.waitForFunction(
    (n) => Array.from(document.querySelectorAll('select option')).some((o) => o.textContent === n),
    name, { timeout: 10000 },
  );
  await page.waitForSelector('text=No multisig loaded', { timeout: 30000 });
}

async function selectProfile(page, name) {
  const value = await page.evaluate(
    (n) => Array.from(document.querySelectorAll('select option')).find((o) => o.textContent === n)?.value ?? null,
    name,
  );
  if (!value) throw new Error(`profile ${name} not found in select`);
  await page.selectOption('select', value);
}

async function profileCommitment(page, name) {
  // Read it directly from the profiles IndexedDB (the bar truncates it).
  return page.evaluate((wantName) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('multisig-tester-profiles');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('profiles', 'readonly');
        const store = tx.objectStore('profiles');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const all = getAll.result;
          const p = all.find((row) => row.name === wantName);
          resolve(p?.commitment ?? null);
        };
        getAll.onerror = () => reject(getAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, name);
}

async function currentAccountId(page) {
  return page.evaluate(() => {
    const div = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
    return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (err) => {
  errors.push(err.message);
  console.log('[browser:pageerror]', err.stack ?? err.message);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await clearStorage(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

log('create profile B and grab its commitment');
await createProfile(page, 'B');
const bCommitment = await profileCommitment(page, 'B');
if (!bCommitment) throw new Error('could not read B commitment from IndexedDB');
log('B commitment:', bCommitment);

log('create profile A');
await createProfile(page, 'A');

log('A: create 2-of-2 multisig that includes B as a cosigner');
await page.click('button:has-text("Create new multisig")');
await page.waitForSelector('textarea', { timeout: 5000 });
await page.locator('textarea').fill(bCommitment);
await page.locator('input[type="number"]').fill('2');
await page.click('button:has-text("Create"):not([disabled])');
await page.waitForSelector('text=/^ID:/', { timeout: 120000 });
const idFromA = await currentAccountId(page);
log('multisig id:', idFromA);

log('switch to B (which has lastAccountId empty); expect auto-discover');
await selectProfile(page, 'B');
// On B: bundle init runs, lastAccountId is empty, discoverAccountsForProfile
// is called and finds idFromA, auto-load follows.
try {
  await page.waitForSelector('text=/^ID:/', { timeout: 60000 });
} catch (e) {
  const status = await page.locator('span.text-zinc-400').first().textContent().catch(() => null);
  const err = await page.locator('span.text-red-400').first().textContent().catch(() => null);
  throw new Error(`B did not auto-load. status=${status} err=${err}`);
}
const idFromB = await currentAccountId(page);
if (idFromB !== idFromA) throw new Error(`B auto-loaded ${idFromB}, expected ${idFromA}`);
log('B auto-loaded:', idFromB);

if (errors.length) throw new Error(`pageerror(s): ${errors.join(' | ')}`);

console.log('\n✓ auto-discover: cosigner-only profile auto-loads via Guardian recoverByKey.');
await browser.close();
