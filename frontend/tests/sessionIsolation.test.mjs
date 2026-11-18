import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(...segments) {
  return fs.readFileSync(path.join(here, '..', 'src', ...segments), 'utf8');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test('App ignores profile responses that belong to a previous session', () => {
  const source = readSource('App.jsx');
  const profile = section(source, 'const fetchUserProfile', 'useEffect(() => {');

  const awaited = profile.indexOf('await api.get');
  const successGuard = profile.search(/if \(tokenRef\.current !== authToken\) return;/);
  const failureGuard = profile.lastIndexOf('if (tokenRef.current !== authToken) return;');

  assert.ok(awaited > -1, 'profile fetch must await the request');
  assert.ok(successGuard > awaited, 'success must be guarded after the await');
  assert.ok(failureGuard > awaited, 'failure must be guarded after the await');
  assert.match(profile, /if \(tokenRef\.current === authToken\) setIsInitializing\(false\)/);

  const logout = section(source, 'const handleLogout', 'const handleLoginSuccess');
  assert.match(logout, /tokenRef\.current = null;/);

  const login = section(source, 'const handleLoginSuccess', '// --- 4. RENDER LOGIC ---');
  assert.match(login, /tokenRef\.current = userToken;/);
});

test('AICopilot discards results from a session that is no longer current', () => {
  const source = readSource('components', 'AICopilot.jsx');

  assert.match(source, /const tokenRef = useRef\(token\)/);
  assert.match(source, /const mountedRef = useRef\(true\)/);
  assert.match(source, /mountedRef\.current && tokenRef\.current === sessionToken/);

  const command = section(source, 'const handleCommand', 'const reportExecutionSuccess');
  assert.ok(command.indexOf('await requestProposal') > -1);
  assert.ok(
    command.indexOf('await requestProposal')
      < command.indexOf('if (!isSessionCurrent(sessionToken)) return;'),
    'command results must be guarded after the await'
  );

  const confirm = section(source, 'const handleConfirm', 'const handleDiscard');
  assert.ok(confirm.indexOf('await confirmProposal') > -1);
  assert.ok(
    confirm.indexOf('await confirmProposal')
      < confirm.lastIndexOf('if (!isSessionCurrent(sessionToken)) return;'),
    'confirm results must be guarded after the await'
  );
  assert.match(confirm, /token: sessionToken/);
  assert.match(confirm, /reportExecutionSuccess\(current, result, sessionToken\)/);

  const discard = section(source, 'const handleDiscard', 'const preview = proposal');
  assert.ok(
    discard.indexOf('await resolveDiscard')
      < discard.indexOf('if (!isSessionCurrent(sessionToken)) return;'),
    'discard results must be guarded after the await'
  );
  assert.match(discard, /token: sessionToken/);

  const success = section(source, 'const reportExecutionSuccess', 'const handleConfirm');
  assert.match(success, /if \(!isSessionCurrent\(sessionToken\)\) return;/);
});
