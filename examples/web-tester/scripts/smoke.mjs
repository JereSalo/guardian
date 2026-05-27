// Headless smoke test for the web-tester UI.
// Assumes dev server is already running at http://localhost:3002/.

import { chromium } from 'playwright';

const URL = 'http://localhost:3002/';

function log(...args) {
  console.log('[smoke]', ...args);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', (msg) => {
  console.log(`[browser:${msg.type()}]`, msg.text());
});
page.on('pageerror', (err) => {
  console.log('[browser:pageerror]', err.stack ?? err.message);
});

log('Navigating to', URL);
await page.goto(URL, { waitUntil: 'networkidle' });

// Clear all storage so the test is repeatable
log('Clearing storage…');
await page.evaluate(async () => {
  localStorage.clear();
  sessionStorage.clear();
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.map((db) => new Promise((res) => {
    const r = indexedDB.deleteDatabase(db.name);
    r.onsuccess = () => res();
    r.onerror = () => res();
    r.onblocked = () => res();
  })));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

log('Filling new profile name and clicking + New profile…');
await page.fill('input[placeholder="new profile name"]', 'A');
await page.click('button:has-text("+ New profile")');

await page.waitForTimeout(5000);

const errorBanner = await page.locator('text=/^⚠/').textContent().catch(() => null);
if (errorBanner) log('Error banner:', errorBanner);

const status = await page.locator('div.text-zinc-400').first().textContent().catch(() => null);
log('Status text:', status);

// Verify setup panel is now shown (No multisig loaded)
const setupVisible = await page.getByText('No multisig loaded').isVisible().catch(() => false);
log('Setup panel visible:', setupVisible);

await page.screenshot({ path: '/tmp/web-tester-smoke.png', fullPage: true });
log('Screenshot saved: /tmp/web-tester-smoke.png');

await browser.close();
if (errorBanner) process.exit(1);
