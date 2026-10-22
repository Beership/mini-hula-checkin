'use strict';
// Configuration loader. Everything user-specific lives in config/ and data/;
// the source tree itself contains no tokens, account names, or local paths.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = process.env.HULA_DATA_DIR
  ? path.resolve(process.env.HULA_DATA_DIR)
  : path.join(ROOT, 'data');

function readJson(file) {
  // Notepad and PowerShell's Set-Content -Encoding UTF8 may add a BOM.
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function loadApps() {
  const file = path.join(CONFIG_DIR, 'apps.json');
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file}`);
  }
  const cfg = readJson(file);
  if (!cfg.base || !Array.isArray(cfg.apps) || cfg.apps.length === 0) {
    throw new Error('config/apps.json must contain "base" and a non-empty "apps" array');
  }
  const apps = {};
  for (const app of cfg.apps) {
    if (!app.key || !app.name || !app.appid) {
      throw new Error('each app needs key, name and appid');
    }
    if (apps[app.key]) {
      throw new Error(`duplicate app key: ${app.key}`);
    }
    apps[app.key] = app;
  }
  return { base: cfg.base, apps };
}

const { base: BASE, apps: APPS } = loadApps();

function loadConfig() {
  const userFile = path.join(CONFIG_DIR, 'config.json');
  const exampleFile = path.join(CONFIG_DIR, 'config.example.json');
  const file = fs.existsSync(userFile) ? userFile : exampleFile;
  const cfg = readJson(file);

  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
    cfg.accounts = [{ id: 'default', name: '默认账号', apps: Object.keys(APPS) }];
  }
  for (const account of cfg.accounts) {
    if (!account.id) throw new Error('every account needs an id');
    if (!Array.isArray(account.apps) || account.apps.length === 0) {
      account.apps = Object.keys(APPS);
    }
    for (const key of account.apps) {
      if (!APPS[key]) {
        throw new Error(`account ${account.id} references unknown app ${key}`);
      }
    }
  }
  if (!cfg.currentAccount || !cfg.accounts.some((a) => a.id === cfg.currentAccount)) {
    cfg.currentAccount = cfg.accounts[0].id;
  }
  if (!cfg.notify) cfg.notify = { toast: true, webhook: { type: '', url: '' } };
  if (!cfg.notify.webhook) cfg.notify.webhook = { type: '', url: '' };
  return cfg;
}

function getAccount(id) {
  const cfg = loadConfig();
  const account = cfg.accounts.find((a) => a.id === id);
  if (!account) {
    throw new Error(`unknown account: ${id} (known: ${cfg.accounts.map((a) => a.id).join(', ')})`);
  }
  return account;
}

function getApp(key) {
  const app = APPS[key];
  if (!app) {
    throw new Error(`unknown app: ${key} (known: ${Object.keys(APPS).join(', ')})`);
  }
  return app;
}

function currentAccountId() {
  return process.env.HULA_ACCOUNT || 'default';
}

function accountPaths(accountId = currentAccountId(), appKey = '') {
  const base = path.join(DATA_DIR, 'accounts', accountId);
  const out = {
    base,
    tokens: path.join(base, 'tokens'),
    state: path.join(base, 'state'),
    logs: path.join(base, 'logs'),
  };
  if (appKey) {
    out.token = path.join(out.tokens, `${appKey}.json`);
    out.subscribed = path.join(out.state, `${appKey}_subscribed.json`);
    out.log = path.join(out.logs, `${appKey}.log`);
    out.result = path.join(base, `last_result_${appKey}.json`);
  }
  return out;
}

function globalPaths() {
  return {
    data: DATA_DIR,
    tmp: path.join(DATA_DIR, 'tmp'),
    logs: path.join(DATA_DIR, 'logs'),
    lock: path.join(DATA_DIR, 'run.lock'),
    marker: path.join(DATA_DIR, 'last_run.txt'),
    lastRun: path.join(DATA_DIR, 'last_run.json'),
    statusText: path.join(DATA_DIR, 'last_status.txt'),
    statusJson: path.join(DATA_DIR, 'last_status.json'),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureGlobalDirs() {
  const p = globalPaths();
  for (const d of [p.data, p.tmp, p.logs]) ensureDir(d);
  return p;
}

function ensureAccountDirs(accountId = currentAccountId()) {
  const p = accountPaths(accountId);
  for (const d of [p.base, p.tokens, p.state, p.logs]) ensureDir(d);
  return p;
}

module.exports = {
  ROOT,
  CONFIG_DIR,
  DATA_DIR,
  BASE,
  APPS,
  readJson,
  writeJson,
  loadApps,
  loadConfig,
  getAccount,
  getApp,
  currentAccountId,
  accountPaths,
  globalPaths,
  ensureDir,
  ensureGlobalDirs,
  ensureAccountDirs,
};
