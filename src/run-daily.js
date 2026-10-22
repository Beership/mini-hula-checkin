'use strict';
// Daily orchestrator: refresh tokens when needed, run each account/app, then
// write a machine-readable result and send one notification.
//
// Usage:
//   node src/run-daily.js                     all accounts, all apps
//   node src/run-daily.js --account me        one account
//   node src/run-daily.js --app hula          one app
//   node src/run-daily.js --all-accounts
//   node src/run-daily.js --no-refresh --no-notify

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT, DATA_DIR, APPS, loadConfig, accountPaths, globalPaths,
  ensureGlobalDirs, ensureAccountDirs,
} = require('./config');

const NODE = process.execPath;
const POWERSHELL = 'powershell.exe';
const STALE_LOCK_MINUTES = 30;

function parseArgs(argv) {
  const out = {
    accounts: [],
    apps: [],
    allAccounts: false,
    noRefresh: false,
    noNotify: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account' && argv[i + 1]) out.accounts.push(argv[++i]);
    else if (a.startsWith('--account=')) out.accounts.push(a.split('=')[1]);
    else if (a === '--app' && argv[i + 1]) out.apps.push(argv[++i]);
    else if (a.startsWith('--app=')) out.apps.push(a.split('=')[1]);
    else if (a === '--all-accounts') out.allAccounts = true;
    else if (a === '--no-refresh') out.noRefresh = true;
    else if (a === '--no-notify') out.noNotify = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node src/run-daily.js [options]

Options:
  --account <id>     run one account (repeatable)
  --all-accounts     run every configured account
  --app <key>        run one app (repeatable)
  --no-refresh       do not try to refresh expired tokens
  --no-notify        do not show a toast / send a webhook
  -h, --help         show this help

With no options, every account and every app is run.`);
}

function run(cmd, args, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...(env || {}) },
    encoding: 'utf8',
    ...rest,
  });
}

function tokenCheck(accountId, appKey) {
  const r = run(NODE, ['src/hula.js', appKey, 'token'], {
    env: { HULA_ACCOUNT: accountId },
    stdio: 'pipe',
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

function refresh(accountId) {
  console.log(`\n--- refreshing tokens for account ${accountId} ---`);
  const r = run(POWERSHELL, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'tools', 'refresh_token_auto.ps1'),
    '-Account', accountId,
  ], { stdio: 'pipe' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (text) {
    console.log(text.trimEnd());
    try {
      fs.appendFileSync(
        path.join(globalPaths().logs, 'refresh.log'),
        `[${new Date().toISOString()}] account=${accountId}\n${text}\n`,
        'utf8'
      );
    } catch {}
  }
  return r.status === 0;
}

function runApp(accountId, appKey) {
  console.log(`\n=== ${accountId} / ${appKey} ===`);
  const r = run(NODE, ['src/hula.js', appKey, 'daily'], {
    env: { HULA_ACCOUNT: accountId },
    stdio: 'inherit',
    encoding: undefined,
  });
  const resultFile = accountPaths(accountId, appKey).result;
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  if (!result) {
    return {
      account: accountId,
      app: appKey,
      name: APPS[appKey]?.name || appKey,
      ok: false,
      error: 'no result file',
    };
  }
  result.ok = !!result.ok && r.status === 0;
  return result;
}

function acquireLock() {
  const p = ensureGlobalDirs();
  try {
    fs.mkdirSync(p.lock);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let ageMin = 0;
    try {
      ageMin = (Date.now() - fs.statSync(p.lock).mtimeMs) / 60000;
    } catch {}
    if (ageMin > STALE_LOCK_MINUTES) {
      console.log(`removing stale lock (${Math.round(ageMin)} min old)`);
      fs.rmSync(p.lock, { recursive: true, force: true });
      try { fs.mkdirSync(p.lock); return true; } catch { return false; }
    }
    console.log('another run is in progress, skipping');
    return false;
  }
}

function releaseLock() {
  try { fs.rmSync(globalPaths().lock, { recursive: true, force: true }); } catch {}
}

function formatLine(account, result, multi) {
  const prefix = multi && account.name ? `[${account.name}] ` : '';
  const name = result.name || result.app;
  if (!result.ok) {
    return `${prefix}${name}: ❌ ${result.error || '执行失败'}`;
  }
  if ((result.delta || 0) > 0) {
    return `${prefix}${name}: ✅ ${result.before} → ${result.after} (+${result.delta})`;
  }
  return `${prefix}${name}: ✅ 今日已完成（${result.after} 分）`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return 0; }
  if (process.platform !== 'win32') {
    console.error('This project supports Windows only (it reads WeChatAppEx memory).');
    return 1;
  }

  const cfg = loadConfig();
  let accounts = cfg.accounts;
  if (!args.allAccounts && args.accounts.length) {
    accounts = accounts.filter((a) => args.accounts.includes(a.id));
    const missing = args.accounts.filter((id) => !accounts.some((a) => a.id === id));
    if (missing.length) {
      console.error(`unknown account(s): ${missing.join(', ')}`);
      return 1;
    }
  }
  if (!accounts.length) {
    console.error('no accounts selected');
    return 1;
  }

  const fullRun = !args.accounts.length && !args.apps.length;
  if (!acquireLock()) return 0;

  const allResults = [];
  try {
    for (const account of accounts) {
      ensureAccountDirs(account.id);
      const appKeys = args.apps.length ? args.apps : account.apps;
      for (const key of appKeys) {
        if (!APPS[key]) {
          allResults.push({ account: account.id, app: key, name: key, ok: false, error: 'unknown app' });
        }
      }
      const validKeys = appKeys.filter((key) => APPS[key]);

      const canRefresh = account.id === cfg.currentAccount;
      let checks = validKeys.map((key) => ({ key, ...tokenCheck(account.id, key) }));
      if (checks.some((c) => !c.ok) && !args.noRefresh) {
        if (canRefresh) {
          refresh(account.id);
          checks = validKeys.map((key) => ({ key, ...tokenCheck(account.id, key) }));
        } else {
          console.log(`\nskip token refresh for ${account.id}: current WeChat account is ${cfg.currentAccount}`);
          console.log(`switch WeChat to ${account.id}, set "currentAccount": "${account.id}" in config/config.json,`);
          console.log(`then run: harvest.bat --account ${account.id}`);
        }
      }

      for (const check of checks) {
        if (!check.ok) {
          console.error(`\n${account.id}/${check.key}: token invalid`);
          if (account.id === cfg.currentAccount) {
            console.error(`open WeChat and "${APPS[check.key].name}" once, then run:`);
            console.error(`  harvest.bat --account ${account.id}`);
          } else {
            console.error(`this account is not the current WeChat login (${cfg.currentAccount}).`);
            console.error(`switch WeChat to "${account.id}", set "currentAccount": "${account.id}" in config/config.json,`);
            console.error(`then run: harvest.bat --account ${account.id}`);
          }
          allResults.push({
            account: account.id,
            app: check.key,
            name: APPS[check.key].name,
            ok: false,
            error: 'token invalid',
          });
          continue;
        }
        const result = runApp(account.id, check.key);
        result.account = account.id;
        result.accountName = account.name;
        allResults.push(result);
      }
    }
  } finally {
    releaseLock();
  }

  const okCount = allResults.filter((r) => r.ok).length;
  const failCount = allResults.length - okCount;
  const total = allResults.reduce((n, r) => n + (r.ok ? (r.delta || 0) : 0), 0);

  const multi = accounts.length > 1;
  const lines = allResults.map((r) => {
    const account = accounts.find((a) => a.id === r.account) || { id: r.account, name: r.account };
    return formatLine(account, r, multi);
  });
  if (okCount > 0) lines.push(`合计 +${total} 分`);

  const title = failCount === 0 ? '每日签到成功' : (okCount === 0 ? '每日签到失败' : '每日签到部分成功');
  const kind = failCount === 0 ? 'success' : 'failure';
  const message = lines.join('\n') + `\n详情: ${globalPaths().lastRun}`;

  const report = {
    at: new Date().toISOString(),
    title,
    kind,
    ok: failCount === 0,
    total,
    results: allResults,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(globalPaths().lastRun, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.appendFileSync(
    path.join(globalPaths().logs, 'daily.log'),
    `[${new Date().toISOString()}] ${title} | ${lines.join(' | ')}\n`,
    'utf8'
  );

  if (!args.noNotify) {
    run(POWERSHELL, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'tools', 'notify.ps1'),
      '-Title', title,
      '-Message', message,
      '-Kind', kind,
    ], { stdio: 'inherit', encoding: undefined });
  }

  if (fullRun && failCount === 0) {
    fs.writeFileSync(globalPaths().marker, new Date().toISOString().slice(0, 10) + '\n', 'ascii');
  }

  console.log(`\n${title}: ${okCount} ok, ${failCount} failed, total +${total}`);
  return failCount === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e.stack || e.message);
  process.exitCode = 1;
}
