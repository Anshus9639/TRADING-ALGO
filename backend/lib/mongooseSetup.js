// Indexes and collections are part of the financial invariants (unique
// idempotency keys, escrow lookups). Startup verifies them read-only, so
// Mongoose must never build them implicitly on connect: creating a missing
// index or collection silently would mask the preflight and change schema
// outside an approved migration.
function applySafeMongooseDefaults(instance) {
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
}

module.exports = { applySafeMongooseDefaults };
