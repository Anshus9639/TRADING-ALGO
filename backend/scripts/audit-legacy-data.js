#!/usr/bin/env node
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { auditLegacyData } = require('./legacyMigration');

function parseArgs(argv) {
  const args = { json: false, help: false };

  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/audit-legacy-data.js [--json]',
    '',
    'Read-only audit of embedded legacy pendingOrders/trades and their migration',
    'status. Performs zero writes and reports ambiguous records instead of',
    'guessing at financial values.'
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

  await mongoose.connect(uri);
  try {
    const report = await auditLegacyData({ User, Order, Trade });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(JSON.stringify({
        readOnly: report.readOnly,
        collections: report.collections,
        legacy: report.legacy,
        migration: report.migration,
        ambiguity: {
          total: report.ambiguity.total,
          errors: report.ambiguity.errors,
          warnings: report.ambiguity.warnings,
          issueCounts: report.ambiguity.issueCounts,
          sample: report.ambiguity.issues.slice(0, 20)
        },
        notes: report.notes
      }, null, 2));
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
      console.error(`Audit aborted: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, usage, main };
