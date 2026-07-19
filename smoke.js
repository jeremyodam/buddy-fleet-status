/*
 * Nightly fleet smoke: five assertions per app, not an HTTP ping.
 * HTTP 200 lies for SPAs -- Vercel's CDN serves index.html even when the JS bundle
 * white-screens. So: page loads, shell actually renders text, zero console errors,
 * zero page errors, no failed same-origin requests.
 *
 * ALL third-party origins are aborted at the network layer. That is the structural
 * fix for the Apple rate-limit burn (automated tests from a home IP hammered the
 * iTunes API until Apple throttled the network). Nightly traffic is exactly one
 * page-load per app, against Vercel's CDN, from GitHub's runners.
 *
 * One sequential job, no matrix: matrix jobs racing to commit status JSONs to the
 * same branch lose to each other. Five apps at ~20s each is fine in series.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APPS = [
  { id: 'guitarbuddy', url: 'https://guitarbuddy-app.vercel.app/', bootWait: 7000 },
  { id: 'garagebuddy', url: 'https://garagebuddy-app.vercel.app/', bootWait: 6000 },
  { id: 'poolandspa', url: 'https://poolandspabuddy.vercel.app/', bootWait: 5000 },
  { id: 'ductly', url: 'https://ductly-nu.vercel.app/', bootWait: 5000 },
  { id: 'bedtime', url: 'https://grandpas-bedtime-stories.vercel.app/', bootWait: 5000 },
];

(async () => {
  fs.mkdirSync(path.join(__dirname, 'status'), { recursive: true });   // git does not track empty dirs
  const browser = await chromium.launch();
  let anyFail = false;

  for (const app of APPS) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const consoleErrors = [];
    const pageErrors = [];
    const failedFirstParty = [];
    const origin = new URL(app.url).origin;

    // abort every third-party request -- no analytics, no Apple, no fonts, nothing
    await page.route('**/*', route => {
      const u = route.request().url();
      // First-party and static-asset CDNs pass (GarageBuddy compiles JSX via a CDN
      // Babel at runtime -- a real user loads it, so the smoke must too). Every API
      // origin still gets aborted: the Apple rate-limit lesson is permanent.
      const cdnOk = /^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//.test(u);
      if (u.startsWith(origin) || u.startsWith('data:') || cdnOk) route.continue();
      else route.abort();
    });
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // Browser-generated resource messages are the echo of OUR third-party aborts.
      if (/Failed to load resource/.test(m.text())) return;
      consoleErrors.push(m.text());
    });
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('requestfailed', r => {
      if (r.url().startsWith(origin) && r.failure() && r.failure().errorText !== 'net::ERR_ABORTED')
        failedFirstParty.push(r.url());
    });

    const checks = { loads: false, renders: false, consoleClean: false, noPageErrors: false, requestsOk: false };
    try {
      const resp = await page.goto(app.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      checks.loads = !!resp && resp.ok();
      // Poll for a rendered shell (boot splashes vary per app) rather than racing a
      // fixed wait. Coarse on purpose: shell visible, not deep flows.
      checks.renders = await page.waitForFunction(
        () => document.body.innerText.trim().length > 100, null, { timeout: 15000 }
      ).then(() => true).catch(() => false);
      await page.waitForTimeout(1500);   // let late console errors land before judging
      checks.consoleClean = consoleErrors.length === 0;
      checks.noPageErrors = pageErrors.length === 0;
      checks.requestsOk = failedFirstParty.length === 0;
    } catch (e) {
      pageErrors.push(String(e).slice(0, 200));
    }
    await page.close();

    const ok = Object.values(checks).every(Boolean);
    const file = path.join(__dirname, 'status', app.id + '.json');
    let streak = 0;
    try { streak = JSON.parse(fs.readFileSync(file, 'utf8')).streak || 0; } catch (e) {}
    const out = {
      ok,
      ts: new Date().toISOString(),
      streak: ok ? 0 : streak + 1,
      checks,
      notes: ok ? '' : [...pageErrors.slice(0, 2), ...consoleErrors.slice(0, 2)].join(' | ').slice(0, 300),
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${app.id}  ${JSON.stringify(checks)}`);
    if (!ok) anyFail = true;
  }

  await browser.close();
  // Always exit 0: the STATUS FILES are the signal. A red workflow on every app
  // hiccup trains the owner to ignore the repo; the dots on the launcher are the UI.
  process.exit(0);
})();
