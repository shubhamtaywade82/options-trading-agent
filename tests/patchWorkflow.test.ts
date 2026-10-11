import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { exec } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PatchWorkflow } from '../src/research/PatchWorkflow.js';
import { CommandPolicy, DEFAULT_ALLOWLIST, DEFAULT_DENYLIST } from '../src/research/CommandPolicy.js';

const execAsync = promisify(exec);

let repoPath: string;

before(async () => {
  // Create a temp git repo for the patch workflow tests.
  repoPath = await mkdtemp(join(tmpdir(), 'patch-test-repo-'));
  await execAsync('git init', { cwd: repoPath });
  await execAsync('git config user.email test@local', { cwd: repoPath });
  await execAsync('git config user.name Test', { cwd: repoPath });
  await execAsync('git checkout -b main', { cwd: repoPath });
  // Create an initial file + commit so the repo has history.
  await writeFile(join(repoPath, 'README.md'), '# Test repo\n', 'utf8');
  await writeFile(join(repoPath, 'package.json'), JSON.stringify({
    name: 'test-repo', version: '1.0.0', scripts: { test: 'node --test test.js' },
  }), 'utf8');
  await execAsync('git add -A', { cwd: repoPath });
  await execAsync('git commit -m "initial"', { cwd: repoPath });
});

after(async () => {
  // Clean up the temp repo and any worktrees it created.
  try { await execAsync(`git -C ${repoPath} worktree prune`); } catch { /* best effort */ }
  await rm(repoPath, { recursive: true, force: true });
});

// ─── Successful patch ──────────────────────────────────────────────────────

test('PatchWorkflow.apply creates a worktree, applies files, and produces a diff', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-001',
    repoPath,
    branch: 'main',
    files: { 'src/new-file.ts': 'export const x = 1;\n' },
    verifyCommands: [],  // no validations — just check the patch applies
  });
  try {
    assert.equal(result.ok, true);
    assert.ok(result.diff.length > 0);
    assert.match(result.diff, /src\/new-file\.ts/);
    // The file should exist in the worktree.
    const content = await readFile(join(result.worktreePath, 'src/new-file.ts'), 'utf8');
    assert.equal(content, 'export const x = 1;\n');
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

test('PatchWorkflow.apply with a commitMessage produces a commit SHA', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-002',
    repoPath,
    branch: 'main',
    files: { 'src/committed.ts': 'export const y = 2;\n' },
    verifyCommands: [],
    commitMessage: 'test: add committed.ts',
  });
  try {
    assert.equal(result.ok, true);
    assert.ok(result.commitSha);
    assert.match(result.commitSha, /^[0-9a-f]{40}$/);
    // The commit should be on the review branch, not main.
    const { stdout: mainLog } = await execAsync(`git -C ${repoPath} log main --oneline`);
    assert.ok(!mainLog.includes(result.commitSha!.slice(0, 7)));
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

test('PatchWorkflow.apply with an empty content string deletes the file', async () => {
  // First, create a file + commit it to the main branch so the delete patch has something to delete.
  await writeFile(join(repoPath, 'src-to-delete.ts'), 'export const z = 3;\n', 'utf8');
  await execAsync('git add -A', { cwd: repoPath });
  await execAsync('git commit -m "add file to delete"', { cwd: repoPath });

  // Now apply a patch that deletes it.
  const wf = new PatchWorkflow();
  const deleteResult = await wf.apply({
    runId: 'test-003b',
    repoPath,
    branch: 'main',
    files: { 'src-to-delete.ts': '' },
    verifyCommands: [],
  });
  try {
    assert.equal(deleteResult.ok, true);
    assert.match(deleteResult.diff, /deleted file/);
  } finally {
    await wf.cleanup(deleteResult.worktreePath, repoPath);
    // Restore the repo state for subsequent tests.
    await execAsync('git checkout src-to-delete.ts', { cwd: repoPath });
  }
});

// ─── Validation ────────────────────────────────────────────────────────────

test('PatchWorkflow.apply runs validation commands and reports their results', async () => {
  // Create a test.js that passes, so `npm test` (allowed by the allowlist) succeeds.
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-004',
    repoPath,
    branch: 'main',
    files: {
      'src/validated.ts': 'export const v = 4;\n',
      'test.js': 'import { test } from "node:test"; test("passes", () => {});\n',
    },
    verifyCommands: ['npm test'],
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.verifyResults.length, 1);
    assert.equal(result.verifyResults[0].ok, true);
    assert.ok(result.verifyResults[0].stdout.length > 0 || result.verifyResults[0].stderr.length > 0);
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

test('PatchWorkflow.apply returns ok=false when a validation command fails', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-005',
    repoPath,
    branch: 'main',
    files: { 'src/failing.ts': 'export const f = 5;\n' },
    // `npm test` runs `node --test test.js` which fails because test.js doesn't exist.
    verifyCommands: ['npm test'],
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.verifyResults.length, 1);
    assert.equal(result.verifyResults[0].ok, false);
    assert.ok(result.verifyResults[0].stderr.length > 0 || result.verifyResults[0].stdout.length > 0);
    assert.match(result.error!, /verification commands failed/);
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

test('PatchWorkflow.apply denies validation commands not on the allowlist', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-006',
    repoPath,
    branch: 'main',
    files: { 'src/denied.ts': 'export const d = 6;\n' },
    verifyCommands: ['python3 malicious.py'],  // not on the allowlist
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.verifyResults[0].ok, false);
    assert.ok(result.verifyResults[0].deniedReason);
    assert.match(result.verifyResults[0].deniedReason!, /not on allowlist/);
    assert.equal(result.verifyResults[0].exitCode, null);
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

test('PatchWorkflow.apply blocks denylisted validation commands', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-007',
    repoPath,
    branch: 'main',
    files: { 'src/blocked.ts': 'export const b = 7;\n' },
    verifyCommands: ['rm -rf data/'],  // on the denylist
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.verifyResults[0].ok, false);
    assert.match(result.verifyResults[0].deniedReason!, /denylist match/);
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

// ─── Multiple files ────────────────────────────────────────────────────────

test('PatchWorkflow.apply handles multiple files in one patch', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-008',
    repoPath,
    branch: 'main',
    files: {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/sub/c.ts': 'export const c = 3;\n',  // nested path — mkdir should create it
    },
    verifyCommands: [],
  });
  try {
    assert.equal(result.ok, true);
    assert.match(result.diff, /src\/a\.ts/);
    assert.match(result.diff, /src\/b\.ts/);
    assert.match(result.diff, /src\/sub\/c\.ts/);
    // The nested file should exist.
    const content = await readFile(join(result.worktreePath, 'src/sub/c.ts'), 'utf8');
    assert.equal(content, 'export const c = 3;\n');
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

// ─── Custom CommandPolicy ──────────────────────────────────────────────────

test('PatchWorkflow with a custom CommandPolicy uses it for validation', async () => {
  // A policy that only allows `echo`.
  const policy = new CommandPolicy([/^echo\s/], DEFAULT_DENYLIST);
  const wf = new PatchWorkflow(policy);
  const result = await wf.apply({
    runId: 'test-009',
    repoPath,
    branch: 'main',
    files: { 'src/custom.ts': 'export const x = 9;\n' },
    verifyCommands: ['echo hello', 'npm test'],  // echo allowed, npm test not (custom allowlist)
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(result.verifyResults[0].ok, true);  // echo
    assert.equal(result.verifyResults[1].ok, false);  // npm test — not on custom allowlist
    assert.match(result.verifyResults[1].deniedReason!, /not on allowlist/);
  } finally {
    await wf.cleanup(result.worktreePath, repoPath);
  }
});

// ─── Error handling ────────────────────────────────────────────────────────

test('PatchWorkflow.apply with a non-existent branch returns ok=false with an error', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-010',
    repoPath,
    branch: 'nonexistent-branch',
    files: { 'src/x.ts': 'export const x = 10;\n' },
    verifyCommands: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  // Clean up the worktree dir that was created before the git command failed.
  if (result.worktreePath) {
    try { await rm(result.worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ─── Cleanup ───────────────────────────────────────────────────────────────

test('PatchWorkflow.cleanup removes the worktree from git and the filesystem', async () => {
  const wf = new PatchWorkflow();
  const result = await wf.apply({
    runId: 'test-011',
    repoPath,
    branch: 'main',
    files: { 'src/cleanup.ts': 'export const c = 11;\n' },
    verifyCommands: [],
  });
  await wf.cleanup(result.worktreePath, repoPath);
  // The worktree directory should be gone.
  let exists = true;
  try { await readFile(join(result.worktreePath, 'src/cleanup.ts'), 'utf8'); } catch { exists = false; }
  assert.equal(exists, false);
  // git worktree list should not include the worktree path.
  const { stdout } = await execAsync(`git -C ${repoPath} worktree list`);
  assert.ok(!stdout.includes(result.worktreePath));
});
