// Hourly uptime check for every live domain.
//
// Hosts come from the UPTIME_HOSTS secret (space or newline separated), not
// from this public repo. State lives in .uptime-state.json, carried between
// runs by actions/cache and never committed, so nothing about which hosts
// exist or are down is published.
//
// Anti-wolf-cry: a host is DOWN only after two failed attempts 20s apart.
// Alerts fire on transitions only (up -> down, down -> up), plus a reminder
// every 6h while something stays down. The job exits 1 on an alert so GitHub
// emails the owner even if the SMS leg is not configured.

const fs = require('fs');

const STATE = '.uptime-state.json';
const REMIND_MS = 6 * 60 * 60 * 1000;
const hosts = (process.env.UPTIME_HOSTS || '').split(/\s+/).filter(Boolean);

if (!hosts.length) {
  console.error('UPTIME_HOSTS is empty; refusing to report green on nothing.');
  process.exit(1);
}

async function probe(host) {
  try {
    const r = await fetch(`https://${host}/`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'odam-uptime/1.0' },
    });
    // A home page never legitimately 404s: Vercel answers a deleted or unlinked
    // project with 404 DEPLOYMENT_NOT_FOUND, so anything >= 400 counts as down.
    return { ok: r.status < 400, code: r.status };
  } catch (e) {
    return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : e.code || e.name };
  }
}

async function check(host) {
  let r = await probe(host);
  if (!r.ok) {
    await new Promise((res) => setTimeout(res, 20000));
    r = await probe(host);
  }
  return { host, ...r };
}

async function sms(text) {
  const token = process.env.SMS_RELAY_TOKEN;
  const to = process.env.SMS_TO;
  if (!token || !to) return 'sms not configured';
  try {
    const r = await fetch('https://buddysuite.vercel.app/api/sms-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Launcher-Token': token },
      body: JSON.stringify({ to, message: text }),
      signal: AbortSignal.timeout(25000),
    });
    const b = await r.json().catch(() => ({}));
    return b.ok ? `sms ${b.status}` : `sms FAILED ${r.status} ${b.error || ''}`;
  } catch (e) {
    return `sms FAILED ${e.name}`;
  }
}

(async () => {
  // Manual "does the phone actually buzz" check, fired from the Actions tab.
  if (process.env.TEST_ALERT === 'true') {
    const r = await sms('[uptime TEST] Alert path works: GitHub -> relay -> your phone. No outage.');
    console.log(r);
    process.exit(r.startsWith('sms ') && !r.includes('FAILED') ? 0 : 1);
  }

  const now = Date.now();
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}

  const results = await Promise.all(hosts.map(check));
  const next = {};
  const wentDown = [], cameBack = [], stillDown = [];

  for (const r of results) {
    const p = prev[r.host] || { ok: true };
    const s = { ok: r.ok, code: r.code, since: p.ok === r.ok && p.since ? p.since : now, alerted: p.alerted || 0 };
    if (!r.ok && p.ok !== false) { wentDown.push(r); s.alerted = now; }
    else if (!r.ok && now - (p.alerted || 0) >= REMIND_MS) { stillDown.push(r); s.alerted = now; }
    else if (r.ok && p.ok === false) { cameBack.push(r); s.alerted = 0; }
    next[r.host] = s;
    console.log(`${r.ok ? 'UP  ' : 'DOWN'} ${r.code}`);  // host names stay out of public logs
  }

  fs.writeFileSync(STATE, JSON.stringify(next));
  const up = results.filter((r) => r.ok).length;
  console.log(`${up}/${results.length} up`);

  const lines = [];
  if (wentDown.length) lines.push('DOWN: ' + wentDown.map((r) => `${r.host} (${r.code})`).join(', '));
  if (stillDown.length) lines.push('STILL DOWN: ' + stillDown.map((r) => r.host).join(', '));
  if (cameBack.length) lines.push('BACK UP: ' + cameBack.map((r) => r.host).join(', '));

  if (lines.length) {
    const msg = `[uptime] ${lines.join(' | ')}`;
    console.log(await sms(msg));
    // Recoveries alone are good news; only fail (and so email) on an outage.
    if (wentDown.length || stillDown.length) {
      console.log('::error::outage detected, see SMS or rerun with debug');
      process.exit(1);
    }
  }
})();
