import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommandPolicy,
  DEFAULT_ALLOWLIST,
  DEFAULT_DENYLIST,
} from '../src/research/CommandPolicy.js';

// ─── Default allowlist / denylist ──────────────────────────────────────────

test('DEFAULT_ALLOWLIST includes npm test, tsc, tsx, git status/log/diff', () => {
  const policy = new CommandPolicy();
  assert.ok(policy.evaluate('npm test').allowed);
  assert.ok(policy.evaluate('npm run typecheck').allowed);
  assert.ok(policy.evaluate('npm run research:golden').allowed);
  assert.ok(policy.evaluate('tsc --noEmit').allowed);
  assert.ok(policy.evaluate('npx tsx scripts/foo.ts').allowed);
  assert.ok(policy.evaluate('git status').allowed);
  assert.ok(policy.evaluate('git log --oneline').allowed);
  assert.ok(policy.evaluate('git diff').allowed);
});

test('DEFAULT_DENYLIST blocks rm -rf, sudo, git push, git reset --hard, mkfs, dd to /dev/', () => {
  const policy = new CommandPolicy();
  assert.ok(!policy.evaluate('rm -rf data/').allowed);
  assert.ok(!policy.evaluate('sudo npm install').allowed);
  assert.ok(!policy.evaluate('git push origin main').allowed);
  assert.ok(!policy.evaluate('git reset --hard HEAD~1').allowed);
  assert.ok(!policy.evaluate('mkfs /dev/sda').allowed);
  assert.ok(!policy.evaluate('dd if=/dev/zero of=/dev/sda').allowed);
});

test('empty command is denied', () => {
  const policy = new CommandPolicy();
  assert.ok(!policy.evaluate('').allowed);
  assert.ok(!policy.evaluate('   ').allowed);
});

test('denylist wins over allowlist when both match', () => {
  // 'git push' is on the denylist; 'git' status etc. are on the allowlist. A command matching both
  // (e.g. 'git push origin main') is denied.
  const policy = new CommandPolicy();
  const result = policy.evaluate('git push origin main');
  assert.ok(!result.allowed);
  assert.ok(result.matchedDeny);
});

// ─── PolicyDecision ─────────────────────────────────────────────────────────

test('evaluate returns matchedAllow when a command is allowed', () => {
  const policy = new CommandPolicy();
  const result = policy.evaluate('npm test');
  assert.ok(result.allowed);
  assert.ok(result.matchedAllow);
});

test('evaluate returns matchedDeny + reason when a command is denied by the denylist', () => {
  const policy = new CommandPolicy();
  const result = policy.evaluate('rm -rf /');
  assert.ok(!result.allowed);
  assert.ok(result.matchedDeny);
  assert.match(result.reason!, /denylist match/);
});

test('evaluate returns reason "not on allowlist" when a command matches neither list', () => {
  const policy = new CommandPolicy();
  const result = policy.evaluate('python3 malicious.py');
  assert.ok(!result.allowed);
  assert.equal(result.reason, 'not on allowlist');
});

// ─── Custom allowlist / denylist ───────────────────────────────────────────

test('a custom allowlist permits only the listed commands', () => {
  const policy = new CommandPolicy([/^echo\s/], DEFAULT_DENYLIST);
  assert.ok(policy.evaluate('echo hello').allowed);
  assert.ok(!policy.evaluate('npm test').allowed);
});

test('a custom denylist blocks the listed commands', () => {
  const policy = new CommandPolicy(DEFAULT_ALLOWLIST, [/\bcurl\b/]);
  assert.ok(!policy.evaluate('curl https://example.com').allowed);
  assert.ok(policy.evaluate('npm test').allowed);
});

// ─── evaluateEnv ───────────────────────────────────────────────────────────

test('evaluateEnv allows PATH/HOME/LANG/NODE_*/CI_* and blocks others', () => {
  const policy = new CommandPolicy();
  const { allowed, blocked } = policy.evaluateEnv({
    PATH: '/usr/bin',
    HOME: '/root',
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'test',
    CI_BUILD: 'true',
    SECRET_API_KEY: 'leak',  // should be blocked
    DATABASE_PASSWORD: 'leak',  // should be blocked
  });
  assert.equal(allowed.PATH, '/usr/bin');
  assert.equal(allowed.HOME, '/root');
  assert.equal(allowed.NODE_ENV, 'test');
  assert.equal(allowed.SECRET_API_KEY, undefined);
  assert.ok(blocked.includes('SECRET_API_KEY'));
  assert.ok(blocked.includes('DATABASE_PASSWORD'));
});

test('evaluateEnv with custom allowedEnvPrefixes', () => {
  const policy = new CommandPolicy(DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, { allowedEnvPrefixes: ['RESEARCH_'] });
  const { allowed, blocked } = policy.evaluateEnv({
    RESEARCH_HOME: '/data',
    PATH: '/usr/bin',  // not in custom prefixes → blocked
  });
  assert.equal(allowed.RESEARCH_HOME, '/data');
  assert.ok(blocked.includes('PATH'));
});

// ─── Options ───────────────────────────────────────────────────────────────

test('maxOutputBytes defaults to 1MB', () => {
  assert.equal(new CommandPolicy().maxOutputBytes, 1024 * 1024);
});

test('timeoutMs defaults to 60s', () => {
  assert.equal(new CommandPolicy().timeoutMs, 60_000);
});

test('custom maxOutputBytes and timeoutMs are respected', () => {
  const policy = new CommandPolicy(DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, { maxOutputBytes: 4096, timeoutMs: 5000 });
  assert.equal(policy.maxOutputBytes, 4096);
  assert.equal(policy.timeoutMs, 5000);
});

// ─── Purity ────────────────────────────────────────────────────────────────

test('evaluate is pure — same command produces the same decision', () => {
  const policy = new CommandPolicy();
  const a = policy.evaluate('npm test');
  const b = policy.evaluate('npm test');
  assert.deepEqual(a, b);
});
