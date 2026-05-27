// Loads the deployed UI from Tailscale and dumps everything Chrome saw:
// network requests, console messages, pageerrors, plus a final screenshot.
// Helps diagnose "page is black" reports without DevTools on the user side.

import { chromium } from 'playwright';

const URL = process.env.URL ?? 'https://miden-guardian-staging-01.tail48b4d.ts.net:8443/';
const HEADLESS = process.env.HEADLESS !== '0';

const browser = await chromium.launch({ headless: HEADLESS, ignoreHTTPSErrors: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const network = [];
page.on('request', (r) => network.push({ kind: 'req', url: r.url(), method: r.method() }));
page.on('response', (r) => network.push({ kind: 'res', url: r.url(), status: r.status() }));
page.on('requestfailed', (r) => network.push({ kind: 'fail', url: r.url(), err: r.failure()?.errorText }));
page.on('pageerror', (e) => console.log('[pageerror]', e.stack ?? e.message));
page.on('console', (msg) => console.log(`[${msg.type()}]`, msg.text()));

console.log(`Loading ${URL} …`);
const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => {
  console.log('[goto error]', e.message);
  return null;
});
console.log('Top-level response:', resp?.status());

await page.waitForTimeout(3000);

const title = await page.title();
const bodyHasContent = await page.evaluate(() => document.body?.innerText?.trim()?.length ?? 0);
console.log('title:', title, '/ body chars:', bodyHasContent);

// Snapshot the early UI: header + status + any error banner.
const headerText = await page.locator('header').first().textContent().catch(() => null);
const statusText = await page.locator('span.text-zinc-400').first().textContent().catch(() => null);
const errorText = await page.locator('span.text-red-400').first().textContent().catch(() => null);
console.log('header:', headerText);
console.log('status:', statusText);
console.log('error:', errorText);

// Show 4xx/5xx and failed requests prominently.
const bad = network.filter((n) => (n.kind === 'res' && n.status >= 400) || n.kind === 'fail');
if (bad.length) {
  console.log('\nProblematic network entries:');
  for (const b of bad) console.log('  ', JSON.stringify(b));
}

await page.screenshot({ path: '/tmp/smoke-remote.png', fullPage: true });
console.log('\nScreenshot: /tmp/smoke-remote.png');
await browser.close();
