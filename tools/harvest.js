'use strict';
// Scan WeChat's mini-program process for bearer tokens and save the ones the
// server accepts. Run this after logging into WeChat and opening each target
// mini-program once.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, loadConfig, ensureGlobalDirs } = require('../src/config');

function parseAccount(argv) {
  let account = 'default';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account' && argv[i + 1]) account = argv[++i];
    else if (argv[i].startsWith('--account=')) account = argv[i].split('=')[1];
  }
  return account;
}

function main() {
  if (process.platform !== 'win32') {
    console.error('This project currently supports Windows only (it reads WeChatAppEx memory).');
    return 1;
  }
  const account = parseAccount(process.argv.slice(2));
  const cfg = loadConfig();
  const accountCfg = cfg.accounts.find((a) => a.id === account);
  if (!accountCfg) {
    console.error(`unknown account: ${account} (known: ${cfg.accounts.map((a) => a.id).join(', ')})`);
    return 1;
  }
  if (cfg.currentAccount && cfg.currentAccount !== account) {
    console.error(`config currentAccount is "${cfg.currentAccount}", not "${account}".`);
    console.error('Switch WeChat to the target account and update currentAccount in config/config.json first.');
    return 1;
  }

  const p = ensureGlobalDirs();
  const outFile = path.join(p.tmp, 'tokens.txt');

  console.log(`Harvesting for account: ${accountCfg.id} (${accountCfg.name})`);
  console.log('WARNING: the tokens found belong to the currently logged-in WeChat account.');
  console.log('Make sure that is the account this profile is for.');
  console.log('');
  console.log('Scanning WeChatAppEx memory...');
  console.log('Make sure WeChat is logged in and each target mini-program has been opened once.');
  const scan = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'tools', 'scan_tokens.ps1'),
    '-OutFile', outFile,
  ], { cwd: ROOT, stdio: 'inherit' });
  if (scan.status !== 0) {
    try { fs.unlinkSync(outFile); } catch {}
    console.error('scan_tokens.ps1 failed');
    return 1;
  }

  const save = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'save_tokens.js'),
    '--account', account,
  ], { cwd: ROOT, stdio: 'inherit' });
  if (save.status !== 0) {
    console.error('save_tokens.js failed - no accepted token for one or more apps');
    return 1;
  }
  console.log(`tokens saved for account: ${account}`);
  return 0;
}

process.exitCode = main();
