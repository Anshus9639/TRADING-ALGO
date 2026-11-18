const { parseArgs } = require('../scripts/verify-migration');
const { applySafeMongooseDefaults } = require('../lib/mongooseSetup');

describe('migration verification CLI arguments', () => {
  test('omitting --backup remains valid', () => {
    expect(parseArgs([]).backup).toBeNull();
    expect(parseArgs(['--strict', '--json'])).toMatchObject({
      backup: null,
      strict: true,
      json: true
    });
  });

  test('--backup accepts a separate or inline file path', () => {
    expect(parseArgs(['--backup', '/tmp/users.json'])).toMatchObject({ backup: '/tmp/users.json' });
    expect(parseArgs(['--backup=/tmp/users.json'])).toMatchObject({ backup: '/tmp/users.json' });
  });

  test('--backup rejects a missing, empty or option-looking value', () => {
    expect(() => parseArgs(['--backup'])).toThrow('--backup requires a file path.');
    expect(() => parseArgs(['--backup='])).toThrow('--backup requires a file path.');
    expect(() => parseArgs(['--backup', '--strict'])).toThrow('--backup requires a file path.');
    expect(() => parseArgs(['--backup=-h'])).toThrow('--backup requires a file path.');
    expect(() => parseArgs(['--backup=--strict'])).toThrow('--backup requires a file path.');
    // The option is not silently treated as satisfying --backup.
    expect(() => parseArgs(['--strict', '--backup'])).toThrow('--backup requires a file path.');
  });
});

describe('mongoose startup defaults', () => {
  test('automatic index and collection creation are disabled before connect', () => {
    const set = jest.fn();
    applySafeMongooseDefaults({ set });

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith('autoIndex', false);
    expect(set).toHaveBeenCalledWith('autoCreate', false);
  });
});
