'use strict';
// First-run setup: create config/config.json (if missing), data directories,
// and print the onboarding steps. Safe to run repeatedly.

const fs = require('fs');
const path = require('path');
const {
  ROOT, CONFIG_DIR, loadConfig, ensureGlobalDirs, ensureAccountDirs,
} = require('../src/config');

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Node.js ${process.versions.node} is too old; install Node.js 18+ from https://nodejs.org/`);
    return 1;
  }

  const userCfg = path.join(CONFIG_DIR, 'config.json');
  const exampleCfg = path.join(CONFIG_DIR, 'config.example.json');
  if (!fs.existsSync(userCfg)) {
    if (!fs.existsSync(exampleCfg)) {
      console.error('config/config.example.json is missing');
      return 1;
    }
    fs.copyFileSync(exampleCfg, userCfg);
    console.log('created config/config.json from config.example.json');
  } else {
    console.log('config/config.json already exists, keeping it');
  }

  ensureGlobalDirs();
  const cfg = loadConfig();
  for (const account of cfg.accounts) {
    ensureAccountDirs(account.id);
    console.log(`account: ${account.id} (${account.name}) apps=${account.apps.join(',')}`);
  }

  console.log('');
  console.log('Setup complete. Next:');
  console.log('  1. Log into WeChat on this PC.');
  console.log('  2. Open each target mini-program once (so its container has a token).');
  console.log('  3. Run:  harvest.bat --account default');
  console.log('  4. Run:  doctor.bat');
  console.log('  5. Run:  daily.bat');
  console.log('');
  console.log('For multiple WeChat accounts, edit config/config.json and repeat');
  console.log('steps 1-3 for each account id. Update "currentAccount" to the account');
  console.log('you are logged into before harvesting; only that account can refresh');
  console.log('its own token.');
  return 0;
}

process.exitCode = main();
