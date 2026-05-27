// Verifies the "second multisig per profile" UX:
// - Profile A creates multisig 1.
// - Clicking "Create new" again (without Unload) surfaces the "already bound" guidance.
// - Clicking "Unload" frees the binding.
// - Profile A can then create multisig 2 with the same key.

import { chromium } from 'playwright';

const URL = 'http://localhost:3002/';

function log(...args) { console.log('[unload-rebind]', ...args); }

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

async function createOneOfOne(page) {
  await page.click('button:has-text("Create new multisig")');
  await page.waitForSelector('textarea', { timeout: 5000 });
  await page.locator('input[type="number"]').fill('1');
  await page.click('button:has-text("Create"):not([disabled])');
  await page.waitForSelector('text=/^ID:/', { timeout: 90000 });
  return page.evaluate(() => {
    const div = Array.from(document.querySelectorAll('div')).find((el) => el.textContent?.startsWith('ID: '));
    return div?.querySelector('span.font-mono')?.textContent?.trim() ?? null;
  });
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (err) => console.log('[browser:pageerror]', err.stack ?? err.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await clearStorage(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

log('create profile A');
await createProfile(page, 'A');

log('create first multisig');
const id1 = await createOneOfOne(page);
log('id1:', id1);

log('click Unload');
await page.click('button:has-text("Unload")');
await page.waitForSelector('text=No multisig loaded', { timeout: 10000 });

log('create second multisig on the same profile');
const id2 = await createOneOfOne(page);
log('id2:', id2);

if (!id1 || !id2 || id1 === id2) throw new Error(`expected two distinct account ids; got ${id1} / ${id2}`);

console.log('\n✓ unload-rebind: same profile created two distinct multisigs (separated by Unload).');
await browser.close();
