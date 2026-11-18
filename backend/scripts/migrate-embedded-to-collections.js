#!/usr/bin/env node
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { isRemoteMongoUri } = require('../config/env');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { runMigration, createBackup } = require('./legacyMigration');

function parseArgs(argv) {
  const args = { apply: false, backup: null, limit: null, json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--backup') {
      args.backup = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--backup=')) {
      args.backup = arg.slice('--backup='.length);
    } else if (arg === '--limit') {
      args.limit = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/migrate-embedded-to-collections.js [--apply] [--backup FILE] [--limit N] [--json]',
    '',
    'Default mode is a read-only dry run. No embedded arrays are deleted or pruned.',
    '',
    'Apply mode (not run in this batch) requires all of:',
    '  --apply',
    '  --backup FILE',
    '  MIGRATION_CONFIRM=APPLY',
    '  A MongoDB replica set (transactions)',
    '  MIGRATION_ALLOW_REMOTE=1 when MONGO_URI is not local'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is required (set it in backend/.env or the environment).');
  }

  const remote = isRemoteMongoUri(uri);
  if (args.apply) {
    if (process.env.MIGRATION_CONFIRM !== 'APPLY') {
      throw new Error('Refusing to apply: set MIGRATION_CONFIRM=APPLY to confirm.');
    }
    if (!args.backup) {
      throw new Error('Refusing to apply: --backup <file> is required before any write.');
    }
    if (remote && process.env.MIGRATION_ALLOW_REMOTE !== '1') {
      throw new Error('Refusing to apply against a remote database. Set MIGRATION_ALLOW_REMOTE=1 only after separate approval.');
    }
  }

  await mongoose.connect(uri);
  try {
    const models = { User, Order, Trade };
    let backup = null;
    if (args.apply) {
      backup = await createBackup(models, args.backup);
    }

    const report = await runMigration({
      ...models,
      mongoose,
      mode: args.apply ? 'apply' : 'dry-run',
      limit: args.limit
    });

    if (backup) report.backup = backup;

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const output = {
        mode: report.mode,
        target: remote ? 'remote' : 'local',
        writes: report.writes,
        usersScanned: report.mode === 'apply' ? report.usersScanned : report.totals.usersScanned,
        usersWithChanges: report.mode === 'apply' ? report.usersUpdated : report.totals.usersWithChanges,
        usersBlocked: report.mode === 'apply' ? report.usersBlocked : report.totals.usersBlocked,
        usersFailed: report.mode === 'apply' ? report.usersFailed : 0,
        orders: report.mode === 'apply' ? report.writes.orders : report.totals.ordersToInsert,
        trades: report.mode === 'apply' ? report.writes.trades : report.totals.tradesToInsert,
        ambiguity: {
          total: report.ambiguity.total,
          errors: report.ambiguity.errors,
          warnings: report.ambiguity.warnings,
          issueCounts: report.ambiguity.issueCounts,
          sample: report.ambiguity.issues.slice(0, 20)
        }
      };
      if (backup) output.backup = backup;
      console.log(JSON.stringify(output, null, 2));
    }

    if (args.apply && report.usersFailed > 0) return 1;
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`Migration aborted: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, usage, main };
