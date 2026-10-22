'use strict';
// Validate the candidates written by scan_tokens.ps1 and save the ones the
// server accepts, one token per app, under data/accounts/<account>/tokens/.
//
// A token recovered from memory is not automatically a NEW token: WeChat may
// hand back the same string. In that case the previous expires_at is kept so
// the file never claims a freshness the server did not grant.

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const {
  BASE, getAccount, getApp, accountPaths, ensureAccountDirs, ensureGlobalDirs,
} = require('../src/config');

function parseArgs(argv) {
  const out = { account: 'default', keepCandidates: false, candidates: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account' && argv[i + 1]) out.account = argv[++i];
    else if (a.startsWith('--account=')) out.account = a.split('=')[1];
    else if (a === '--keep-candidates') out.keepCandidates = true;
    else if (a === '--candidates' && argv[i + 1]) out.candidates = argv[++i];
  }
  return out;
}

function probe(app, token) {
  return new Promise((resolve) => {
    const headers = {
      host: BASE,
      appid: app.appid,
      envversion: 'release',
      version: app.version,
      'xy-extra-data': `appid=${app.appid};version=${app.version};envVersion=release;senceId=1256`,
      'content-type': 'application/json',
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
      authorization: 'bearer ' + token,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) ' +
        'NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF',
    };
    const req = https.request(
      {
        host: BASE,
        port: 443,
        method: 'GET',
        path: '/dtapi/pointsSign/user/pointsInfo/query',
        headers,
        timeout: 12000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
            else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
          } catch {}
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch {}
          resolve(json);
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function loadCandidates(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(raw)];
  const plausible = uniq.filter((t) => t.length >= 24 && t.length <= 120);
  const rest = uniq.filter((t) => !plausible.includes(t));
  return [...plausible, ...rest];
}

function readExisting(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  process.env.HULA_ACCOUNT = args.account;
  ensureGlobalDirs();
  ensureAccountDirs(args.account);

  let account;
  try {
    account = getAccount(args.account);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const candidatesFile = args.candidates || path.join(ensureGlobalDirs().tmp, 'tokens.txt');
  const candidates = loadCandidates(candidatesFile);
  console.log(`account: ${account.id}`);
  console.log(`candidates: ${candidates.length}`);
  if (!candidates.length) {
    console.error('no candidates - open WeChat and the mini-program once, then run harvest.bat');
    if (!args.keepCandidates) { try { fs.unlinkSync(candidatesFile); } catch {} }
    process.exit(1);
  }

  let failures = 0;
  for (const appKey of account.apps) {
    const app = getApp(appKey);
    const tokenFile = accountPaths(account.id, appKey).token;
    const prev = readExisting(tokenFile);
    let winner = null;
    let info = null;
    for (const token of candidates) {
      const json = await probe(app, token);
      if (json && json.error === 0) {
        winner = token;
        info = json.data;
        break;
      }
    }
    if (!winner) {
      console.log(`${appKey}: no candidate accepted`);
      failures++;
      continue;
    }
    const same = prev && prev.access_token === winner;
    const out = {
      app: appKey,
      appid: app.appid,
      access_token: winner,
      token_type: 'bearer',
      expires_in: 86400,
      captured_at: new Date().toISOString(),
      expires_at: same ? prev.expires_at : new Date(Date.now() + 86400 * 1000).toISOString(),
      refreshed: !same,
      source: 'process-memory',
      points_seen: info?.pointsNums,
    };
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(
      `${appKey}: ${same ? 'SAME token (server did not re-issue)' : 'NEW token'} -> ${tokenFile}` +
      ` points=${info?.pointsNums} expires=${out.expires_at}`
    );
  }

  if (!args.keepCandidates) {
    try { fs.unlinkSync(candidatesFile); } catch {}
  }
  if (failures) process.exit(1);
})();
