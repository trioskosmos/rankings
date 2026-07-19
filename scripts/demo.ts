// Records a video demo of the new submit → moderate → aggregate flow against
// the local dev server. Output: docs/demo/<random>.webm  (renamed by caller).
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE ?? 'http://localhost:8788';
const wait = (p: any, ms: number) => p.waitForTimeout(ms);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  recordVideo: { dir: join(root, 'docs/demo'), size: { width: 1280, height: 860 } },
});
const page = await context.newPage();

// 1. Landing / aggregate
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await wait(page, 2200);

// 2. Go to submit page
await page.goto(BASE + '/submit.html', { waitUntil: 'networkidle' });
await wait(page, 1200);

// 3. Fill the form
await page.fill('#rankerName', 'DemoFan');
await wait(page, 500);
await page.selectOption('#scopeType', 'all');
await wait(page, 500);
const listText = [
  'DemoFan',
  '1. Snow halation - μ’s',
  '2. 眩耀夜行 - スリーズブーケ',
  '3. すのーはれーしょん',
  '4. Bokura no LIVE Kimi to no LIFE',
  '5. Love marginal',
  '6. アイコトバ',
  '7. Totally Made Up Song',
].join('\n');
await page.fill('#text', listText);
await wait(page, 1200);

// 4. Parse & preview
await page.click('#parseBtn');
await page.waitForSelector('#itemList .item');
await wait(page, 1800);

// 5. Resolve any yellow/red rows: pick first real candidate, else keep-as-custom
const rows = page.locator('#itemList .item');
const n = await rows.count();
for (let i = 0; i < n; i++) {
  const sel = rows.nth(i).locator('select[data-role=pick]');
  const val = await sel.inputValue();
  if (val === '') {
    const optVals = await sel.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const numeric = optVals.find((v) => /^\d+$/.test(v));
    await sel.scrollIntoViewIfNeeded();
    await wait(page, 500);
    await sel.selectOption(numeric ?? '__custom__');
    await wait(page, 800);
  }
}
await wait(page, 1200);

// 6. Submit
await page.click('#submitBtn');
await page.waitForSelector('#doneCard:not(.hidden)');
await wait(page, 2000);

// 7. Admin: approve
await page.goto(BASE + '/admin.html', { waitUntil: 'networkidle' });
await wait(page, 800);
await page.fill('#token', process.env.ADMIN_TOKEN ?? 'dev-admin-token');
await page.click('#loadBtn');
await page.waitForSelector('[data-id]');
await wait(page, 1200);
await page.locator('[data-act=preview]').first().click();
await wait(page, 1800);
await page.locator('[data-act=approve]').first().click();
await wait(page, 1600);

// 8. Back to aggregate — the new ranking is now live
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await wait(page, 1400);
// switch to Ranking tab and pick the new profile to show it landed
await page.click('[data-tab=rank]');
await wait(page, 2400);

await context.close(); // finalizes the video
await browser.close();
console.log('demo recorded to docs/demo/');
