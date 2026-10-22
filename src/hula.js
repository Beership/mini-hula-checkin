'use strict';
// Points automation for the iyouke / 星云有客 mini-program template.
//
// Auth is a plain bearer token captured from a real mini-program session,
// stored per app. No request signing is involved.
//
// Usage: node src/hula.js [--account <id>] <app> <command> [args]
//        node src/hula.js hula status
//        node src/hula.js --account me jiejie daily
//
// The app key selects appid + quotas; the backend host is shared and the
// tenant is picked from the appid header. Tokens, logs and subscription state
// live under data/accounts/<account>/ so one checkout can serve several
// WeChat accounts without mixing their data.

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const {
  BASE, APPS, getApp, currentAccountId, accountPaths, ensureAccountDirs,
} = require('./config');

const DEFAULT_APP = Object.keys(APPS)[0] || 'hula';
const ensuredAccounts = new Set();

function paths(app) {
  const account = currentAccountId();
  if (!ensuredAccounts.has(account)) {
    ensureAccountDirs(account);
    ensuredAccounts.add(account);
  }
  const p = accountPaths(account, app.key);
  return { token: p.token, subscribed: p.subscribed, log: p.log, result: p.result };
}

// ---------- token ----------
function readToken(app) {
  try {
    const raw = fs.readFileSync(paths(app).token, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadToken(app) {
  return readToken(app)?.access_token || null;
}

function saveToken(app, obj) {
  fs.writeFileSync(paths(app).token, JSON.stringify(obj, null, 2), 'utf8');
}

// Tokens live 24h. Warn loudly before a run so a stale token is not mistaken
// for a code bug.
// The saved expires_at is only an optimistic bound: it is computed when the
// token is recovered from memory, which is later than the server-side issue
// time and may be rewritten by a harvest that got the same string back. So the
// local clock can never prove a token is dead - only the server can.
function tokenStatus(app) {
  const info = readToken(app);
  if (!info) return { ok: false, reason: `token missing for ${app.key} (run harvest.bat)` };
  const exp = info.expires_at ? new Date(info.expires_at).getTime() : null;
  const leftMs = exp ? exp - Date.now() : null;
  return {
    ok: leftMs == null ? true : leftMs > -(24 * 3600000),
    token: info.access_token,
    expiresAt: info.expires_at,
    hoursLeft: leftMs == null ? undefined : Math.round(leftMs / 3600000),
    localExpired: leftMs != null && leftMs <= 0,
    // Callers must confirm with the server; this is a hint, not a verdict.
    needsServerCheck: true,
  };
}

// Authoritative check: does the server still accept this token?
async function tokenLive(app) {
  const st = tokenStatus(app);
  if (!st.token) return { ...st, ok: false };
  const r = await api(app).pointsInfo();
  const ok = !!r.json && r.json.error === 0;
  return {
    ...st,
    ok,
    serverSays: ok ? 'accepted' : (r.json?.errorMsg || r.text.slice(0, 120)),
    points: ok ? r.json.data?.pointsNums : undefined,
  };
}

function log(app, ...args) {
  const line = `[${new Date().toISOString()}] [${app.key}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(paths(app).log, line + '\n'); } catch { }
}

// ---------- transport ----------
function request(app, method, apiPath, body, { timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      host: BASE,
      appid: app.appid,
      envversion: 'release',
      version: app.version,
      'xy-extra-data': `appid=${app.appid};version=${app.version};envVersion=release;senceId=1256`,
      'content-type': 'application/json',
      accept: '*/*',
      referer: `https://servicewechat.com/${app.appid}/${app.pkgVersion}/page-frame.html`,
      'accept-encoding': 'gzip, deflate, br',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) ' +
        'NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) ' +
        'UnifiedPCWindowsWechat(0xf2541b37) XWEB/20089',
    };
    const t = loadToken(app);
    if (t) headers.authorization = 'bearer ' + t;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);

    const req = https.request({ host: BASE, port: 443, method, path: apiPath, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch { }
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, text: 'ERR ' + e.message, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'ERR timeout', json: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- reads ----------
const api = (app) => ({
  pointsInfo: () => request(app, 'GET', '/dtapi/pointsSign/user/pointsInfo/query'),
  signList: () => request(app, 'GET', '/dtapi/pointsSign/user/sign/list'),
  taskList: () => request(app, 'GET', '/dtapi/points/task/list'),
  centerInfo: () => request(app, 'GET', '/dtapi/points/user/centerInfo'),
});

async function points(app) {
  const r = await api(app).pointsInfo();
  if (!r.json || r.json.error !== 0) return null;
  return r.json.data.pointsNums;
}

// ---------- sign-in ----------
// The endpoint is a GET that mutates state (confirmed on hula: +1 point,
// seriesDays 0 -> 1). Do not call it speculatively.
async function checkIn(app) {
  const a = api(app);
  const before = await a.pointsInfo();
  if (!before.json || before.json.error !== 0) {
    return { ok: false, reason: 'pointsInfo failed: ' + before.text.slice(0, 200) };
  }
  const st = before.json.data || {};
  if (st.signTodayResult === true) {
    return { ok: true, alreadyDone: true, points: st.pointsNums, seriesDays: st.seriesDays };
  }
  const r = await request(app, 'GET', '/dtapi/pointsSign/user/sign');
  if (!r.json || r.json.error !== 0) {
    return { ok: false, reason: 'sign failed: ' + r.text.slice(0, 300) };
  }
  const after = await a.pointsInfo();
  return {
    ok: after.json?.data?.signTodayResult === true,
    reward: r.json.data,
    points: after.json?.data?.pointsNums,
    seriesDays: after.json?.data?.seriesDays,
  };
}

// ---------- task status ----------
async function taskStatus(app) {
  const r = await api(app).taskList();
  if (!r.json) return null;
  const out = { balance: r.json.data?.pointsBalance, tasks: [] };
  for (const g of r.json.data?.taskGroupList || []) {
    for (const t of g.tasks || []) {
      if ([2, 3, 4, 22].includes(t.type)) {
        out.tasks.push({
          type: t.type, title: t.title, status: t.status, cycle: t.cycle,
          cycleValue: t.cycleValue, button: t.buttonText, prize: t.prize,
        });
      }
    }
  }
  return out;
}

// finishTask is the claim call. The wish page passes the id returned by
// makeWish as bizId; a claim without bizId is rejected with
// "完成任务才能领取积分哦" even when the task really is complete.
//
// The real endpoint is POST /points/task/submit — both integralTaskCenter and
// packageWish call it. The older /points/task/finishTask path still answers
// but never credits.
async function finishTask(app, taskType, bizId) {
  const body = { taskType };
  if (bizId) body.bizId = bizId;
  const r = await request(app, 'POST', '/dtapi/points/task/submit', body);
  return r.json || { error: -999, errorMsg: r.text.slice(0, 200) };
}

// ---------- wishes ----------
// todayWishTimes is a PER-DAY publish counter for both tenants, but the cap it
// is compared against differs: hula resets every day (3/day), jiejie's reward
// resets weekly (1/week). So todayWishTimes alone cannot tell whether a weekly
// budget is spent - jiejie happily reports 3 after three posts in one day while
// its weekly task is already claimed.
//
// Treat the counter as a lower bound only: if it already reached the cap, the
// budget is definitely gone; otherwise the task status decides.
async function wishQuota(app) {
  const r = await request(app, 'POST', '/dtapi/p/wish/contentConf', {});
  return r.json?.data?.todayWishTimes ?? null;
}

// Whether the wish task is already claimed for this cycle. status 1 = FINISHED
// (claimed), 99 = UNCLAIMED (publish done, reward waiting), 0 = not published.
async function wishTaskStatus(app) {
  const r = await request(app, 'GET', '/dtapi/points/task/22');
  if (!r.json || r.json.error !== 0) return null;
  return r.json.data?.status ?? null;
}

// Publish one wish. Publishing and claiming are separate steps: the reward for
// type 22 is claimed with POST /points/task/submit {taskType:22} and needs no
// bizId. Claiming right after a single publish succeeds but yields nothing
// until the cycle's wishes are used up, so the claim belongs to runWishes
// (once, after the last wish), not here.
//
// The body uses the field names the server returns from /p/wish/info
// (category, pic) rather than the component names the page uses internally.
async function makeWish(app, content) {
  const pub = await request(app, 'POST', '/dtapi/p/myWish/wish', {
    wishContent: content,
    brand: content,
    category: '',
    pic: '',
  });
  if (!pub.json || pub.json.error !== 0) {
    return { ok: false, step: 'publish', reason: pub.json?.errorMsg || pub.text.slice(0, 200) };
  }
  return { ok: true, id: pub.json.data?.id };
}

// ---------- lives ----------
const LIVE_UPCOMING = 1; // 1 = 预告, 2 = 直播中, 3 = 已结束

async function liveList(app) {
  const r = await request(app, 'GET', '/dtapi/channel/live/list');
  return r.json?.list || [];
}

// Lives drop in weekly batches, so "subscribe" must be idempotent: only the
// ids the server reports as not-yet-subscribed are sent, and the result is
// recorded locally so a later run never re-sends them.
function loadSubscribed(app) {
  try {
    return JSON.parse(fs.readFileSync(paths(app).subscribed, 'utf8'));
  } catch {
    return {};
  }
}

function saveSubscribed(app, map) {
  fs.writeFileSync(paths(app).subscribed, JSON.stringify(map, null, 2), 'utf8');
}

async function subscribeNew(app, { dryRun = false } = {}) {
  const lives = await liveList(app);
  const record = loadSubscribed(app);
  const actions = [];

  for (const live of lives) {
    const id = live.liveId;
    if (!id || live.liveStatus !== LIVE_UPCOMING) continue;
    const known = record[id]?.subscribed === true;
    if (live.subscribe === true || known) {
      if (live.subscribe === true && !known) {
        record[id] = { theme: live.theme, startTime: live.startTime, subscribed: true, at: new Date().toISOString() };
      }
      continue;
    }
    if (dryRun) { actions.push({ id, theme: live.theme, action: 'would-subscribe' }); continue; }

    const before = await points(app);
    const r = await request(app, 'POST', `/dtapi/channel/live/subscribe/${id}`);
    const ok = r.json?.error === 0;
    if (ok) {
      record[id] = { theme: live.theme, startTime: live.startTime, subscribed: true, at: new Date().toISOString() };
      const claim = await finishTask(app, 3, id);
      await new Promise((x) => setTimeout(x, 800));
      const after = await points(app);
      actions.push({
        id, theme: live.theme, ok: true, claim: claim.errorMsg || 'ok',
        pointsBefore: before, pointsAfter: after,
        gained: before != null && after != null ? after - before : null,
      });
    } else {
      actions.push({ id, theme: live.theme, ok: false, reason: r.json?.errorMsg || r.text.slice(0, 160) });
    }
  }

  saveSubscribed(app, record);
  return actions;
}

// Viewing a live detail page is the "查看直播预告" action (hula only - jiejie
// has no such task). The page then calls grantReward, reads the task by bizId
// and claims when it is still open.
//
// The page keeps the user on the detail view for a few seconds before firing
// the grant, so the same dwell is reproduced here: the server never sees how
// long the page was open, but matching the real sequence keeps the calls in the
// order the backend expects.
const VIEW_DWELL_MS = 5000;

async function viewLive(app, liveId, { dwellMs = VIEW_DWELL_MS } = {}) {
  const before = await points(app);
  await request(app, 'GET', `/dtapi/channel/live/detail/${liveId}`);
  if (dwellMs > 0) await new Promise((r) => setTimeout(r, dwellMs));
  const grant = await request(app, 'POST', `/dtapi/channel/live/grantReward/${liveId}`);
  const claim = await finishTask(app, 2, liveId);
  await new Promise((r) => setTimeout(r, 800));
  const after = await points(app);
  return {
    liveId,
    grant: grant.json?.data,
    claim: claim.errorMsg || 'ok',
    pointsBefore: before, pointsAfter: after,
    gained: before != null && after != null ? after - before : null,
  };
}

// Every subscribed live gets its detail page opened for the dwell, then the
// grant is fired. The reward itself is capped by the task config, so later
// lives in the same day report "任务已完成" - that is expected, not a failure.
async function viewAllLives(app, { dwellMs = VIEW_DWELL_MS } = {}) {
  const lives = (await liveList(app)).filter((l) => l.liveStatus !== 3);
  const out = [];
  for (const l of lives) {
    out.push(await viewLive(app, l.liveId, { dwellMs }));
  }
  return out;
}

// ---------- wish planning ----------
// The quota is per cycle, so decide from todayWishTimes rather than posting a
// fixed number every day.
//
// The reward is claimed once at the end, after the last wish of the cycle is
// published - a claim made between wishes returns error:0 but pays nothing.
// cycleValue caps how many times type 22 can be claimed in one cycle.
//
// Whether to publish at all is decided by the task status, not by
// todayWishTimes: status 1 means this cycle is already claimed, and the
// counter is per-day so it overshoots weekly caps.
async function runWishes(app, { want } = {}) {
  const used = (await wishQuota(app)) ?? 0;
  const limit = app.wish.limit;
  const status = await wishTaskStatus(app);

  if (status === 1) {
    return { used, limit, status, room: 0, posted: 0, claims: [], gained: 0, results: [], skip: 'already claimed this cycle' };
  }
  // Only a counter at or above the cap proves exhaustion; below it the counter
  // says nothing about a weekly budget.
  const room = used >= limit ? 0 : limit - used;
  const n = want == null ? room : Math.min(want, room);
  const results = [];
  if (n <= 0) return { used, limit, status, room, posted: 0, claims: [], gained: 0, results, skip: 'quota counter at cap' };
  for (let i = 0; i < n; i++) {
    const tag = `hula${Date.now().toString(36)}${i}`;
    results.push({ tag, ...(await makeWish(app, tag)) });
  }
  const posted = results.filter((r) => r.ok).length;
  if (!posted) return { used, limit, status, room, posted, claims: [], gained: 0, results };

  // Now the cycle's wishes are spent; drain the claim budget.
  //
  // "任务提交中，请稍候" means the previous claim is still queueing - it is a
  // "come back in a moment", not "you are done". Breaking on it costs a point
  // per cycle, so busy answers are retried with a longer pause and only
  // "任务已完成" ends the drain.
  const cap = app.wish.cycleValue || 1;
  const claims = [];
  let gained = 0;
  let paid = 0;
  const maxAttempts = cap * 3;
  for (let i = 0; i < maxAttempts && paid < cap; i++) {
    const before = await points(app);
    const r = await finishTask(app, 22);
    const msg = String(r.errorMsg || '');
    const busy = msg.includes('提交中') || msg.includes('领取中');
    // A queued claim needs longer before the balance actually moves.
    await new Promise((res) => setTimeout(res, busy ? 6000 : 2500));
    const after = await points(app);
    const delta = before != null && after != null ? after - before : null;
    claims.push({ attempt: i + 1, resp: r, delta });
    if (delta > 0) { gained += delta; paid += 1; continue; }
    if (msg.includes('已完成')) break;
    if (busy) continue;
    break;
  }
  return { used, limit, status, room, posted, claims, gained, results };
}

module.exports = {
  APPS, BASE, getApp,
  request, api, points, checkIn, taskStatus, finishTask,
  makeWish, wishQuota, wishTaskStatus, runWishes,
  liveList, subscribeNew, viewLive, viewAllLives,
  loadSubscribed, saveSubscribed,
  loadToken, tokenStatus, tokenLive, saveToken, log,
  LIVE_UPCOMING,
};

// ---------- CLI ----------
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--account' && argv[i + 1]) {
        process.env.HULA_ACCOUNT = argv[i + 1];
        argv.splice(i, 2);
        i--;
      } else if (argv[i].startsWith('--account=')) {
        process.env.HULA_ACCOUNT = argv[i].slice('--account='.length);
        argv.splice(i, 1);
        i--;
      }
    }
    const appKey = APPS[argv[0]] ? argv.shift() : DEFAULT_APP;
    const app = getApp(appKey);
    const cmd = argv[0] || 'status';
    const say = (...a) => log(app, ...a);

    if (cmd === 'status') {
      const ts = tokenStatus(app);
      if (ts.ok) say(`token ok${ts.hoursLeft !== undefined ? ` (~${ts.hoursLeft}h left)` : ''}`);
      else {
        say(`TOKEN INVALID: ${ts.reason || 'expired at ' + ts.expiresAt}`);
        say(`  -> open "${app.name}" in WeChat once, then run harvest.bat --account ${currentAccountId()}`);
      }
      const s = await taskStatus(app);
      if (!s) { say('task list failed (token?)'); return; }
      say('balance:', s.balance);
      for (const t of s.tasks) {
        say(`  [${t.status}] type=${t.type} ${t.title} (${t.button}) +${t.prize?.result ?? 0} ${t.cycle}/${t.cycleValue}`);
      }
      const q = await wishQuota(app);
      say(`wish quota used this cycle: ${q} / ${app.wish.limit}`);
    } else if (cmd === 'sign') {
      say(JSON.stringify(await checkIn(app)));
    } else if (cmd === 'token') {
      // Ask the server, not the clock: the saved expiry is only an estimate.
      const ts = await tokenLive(app);
      const safe = { ...ts, token: ts.token ? ts.token.slice(0, 6) + '...' : undefined };
      say(JSON.stringify(safe, null, 2));
      if (!ts.ok) process.exitCode = 1;
    } else if (cmd === 'wish') {
      const want = argv[1] != null ? Number(argv[1]) : undefined;
      const r = await runWishes(app, { want });
      say(`wish used=${r.used} limit=${r.limit} room=${r.room} posted=${r.posted} gained=+${r.gained}${r.skip ? '  (' + r.skip + ')' : ''}`);
      for (const x of r.results) say('  publish ' + JSON.stringify(x));
      for (const c of r.claims) say(`  claim#${c.attempt} delta=${c.delta} ${JSON.stringify(c.resp)}`);
    } else if (cmd === 'subscribe') {
      const actions = await subscribeNew(app, { dryRun: argv.includes('--dry-run') });
      if (!actions.length) say('no un-subscribed upcoming lives');
      for (const a of actions) say('  ' + JSON.stringify(a));
    } else if (cmd === 'view') {
      const liveId = argv[1];
      if (!liveId) { say(`usage: node src/hula.js ${app.key} view <liveId>`); return; }
      say(JSON.stringify(await viewLive(app, liveId)));
    } else if (cmd === 'daily') {
      const before = await points(app);
      say(`--- daily run, points before: ${before}`);

      const sign = await checkIn(app);
      say('sign: ' + JSON.stringify(sign));

      const subs = await subscribeNew(app);
      say('subscribe: ' + JSON.stringify(subs));

      let viewed = null;
      if (app.hasViewLiveTask) {
        viewed = await viewAllLives(app);
        for (const v of viewed) say('view: ' + JSON.stringify(v));
      }

      const w = await runWishes(app);
      say(`wish: status=${w.status} used=${w.used} limit=${w.limit} posted=${w.posted} gained=+${w.gained}${w.skip ? '  (' + w.skip + ')' : ''}`);
      for (const x of w.results) say('  publish ' + JSON.stringify(x));
      for (const c of w.claims) say(`  claim#${c.attempt} delta=${c.delta} ${JSON.stringify(c.resp)}`);

      const after = await points(app);
      say(`--- daily run done, points ${before} -> ${after} (+${(after ?? 0) - (before ?? 0)})`);

      // Status alone is not proof: a task can read status=1 without the reward
      // ever landing. The balance delta is the only trustworthy signal - but a
      // 0 delta is only a failure if there was actually something left to do.
      // After a successful run everything reads status=1 and later runs of the
      // same day legitimately earn nothing.
      const acted = !sign.alreadyDone || subs.length > 0 || w.posted > 0;
      const delta = (after ?? 0) - (before ?? 0);
      if (before != null && after != null && delta <= 0) {
        if (acted) {
          say('WARNING: actions ran but no points landed (0 delta)');
          process.exitCode = 1;
        } else {
          say('nothing left to do today - already complete');
        }
      }
      if (before == null || after == null) process.exitCode = 1;

      // Machine-readable outcome for the notifier. The exit code alone cannot
      // tell "already complete" from "token expired", and daily.bat would have
      // to scrape the log to report the points.
      const ok = before != null && after != null && (delta > 0 || !acted);
      fs.writeFileSync(
        paths(app).result,
        JSON.stringify({
          app: app.key,
          name: app.name,
          at: new Date().toISOString(),
          ok,
          before,
          after,
          delta,
          sign: { ok: !!sign.ok, alreadyDone: !!sign.alreadyDone, reward: sign.reward ?? null },
          subscribed: subs.length,
          subscribedGained: subs.reduce((n, s) => n + (s.gained || 0), 0),
          viewed: Array.isArray(viewed) ? viewed.length : 0,
          wishesPosted: w.posted,
          wishesGained: w.gained,
          error: ok ? null : (before == null || after == null ? 'points unavailable' : 'no points landed'),
        }, null, 2),
        'utf8'
      );
    } else {
      say(`usage: node src/hula.js [--account <id>] [${Object.keys(APPS).join('|')}] [status|sign|token|wish [n]|subscribe [--dry-run]|view <liveId>|daily]`);
    }
  })();
}
