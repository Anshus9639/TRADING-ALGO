#!/usr/bin/env node
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { verifyMigration } = require('./legacyMigration');

function parseArgs(argv) {
  const args = { backup: null, json: false, strict: false, acceptUnknownBasis: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--accept-unknown-basis') args.acceptUnknownBasis = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--backup') {
      args.backup = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--backup=')) {
      args.backup = arg.slice('--backup='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/verify-migration.js [--backup FILE] [--strict] [--accept-unknown-basis] [--json]',
    '',
    'Read-only reconciliation of canonical Order/Trade records, escrow annotations,',
    'and optionally the pre-apply backup. Exits non-zero when checks fail.',
    '--strict also fails when legacy data has reported ambiguities.',
    '--accept-unknown-basis is an explicit disposition: it allows strict mode to',
    'pass when the only remaining warnings are unrecoverable cost bases, which are',
    'stored as null/UNKNOWN rather than zero.'
  ].join('\n');
}

function strictBlockingIssues(report, { acceptUnknownBasis = false } = {}) {
  const issues = report && report.ambiguity && Array.isArray(report.ambiguity.issues)
    ? report.ambiguity.issues
    : [];
  const acceptedCodes = acceptUnknownBasis ? new Set(['MISSING_COST_BASIS']) : new Set();
  return issues.filter(entry => !acceptedCodes.has(entry.code));
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

  await mongoose.connect(uri);
  try {
    const report = await verifyMigration(
      { User, Order, Trade },
      { backupFile: args.backup }
    );

    console.log(JSON.stringify(report, null, 2));

    if (!report.ok) return 1;
    if (args.strict) {
      const blocking = strictBlockingIssues(report, {
        acceptUnknownBasis: args.acceptUnknownBasis
      });
      if (blocking.length > 0) return 1;
    }
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`Verification aborted: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, strictBlockingIssues, usage, main };
