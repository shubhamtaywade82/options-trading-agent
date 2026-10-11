/**
 * Patch workflow — adapted from agent-tui's `supervisor/code/patch.ts` pattern.
 *
 * The agent-tui version uses Docker for sandbox isolation. The crypto-trading-agent version uses a
 * subprocess + git worktree approach: the agent is operating on its own codebase, so Docker isolation
 * is overkill. The worktree provides isolation (changes don't touch the main checkout), and the
 * CommandPolicy provides safety (destructive commands are blocked before they reach the shell).
 *
 * Flow:
 *   1. Create a git worktree on a temp branch.
 *   2. Apply the proposed file changes (relative path → new content).
 *   3. Stage + produce a diff.
 *   4. Optionally commit (still on the temp branch — the operator reviews before merging).
 *   5. Run validation commands (e.g. `npm run typecheck`, `npm test`) in the worktree.
 *   6. If all validations pass → return ok=true with the diff + commit SHA.
 *   7. If any validation fails → return ok=false with the failure output.
 *
 * The workflow NEVER pushes, NEVER merges, NEVER touches the operator's main branch. It produces a
 * worktree + commit that the operator can review (`git -C <worktree> log`, `git -C <worktree> diff`)
 * and merge manually if satisfied. This is the "verification half" of the research plane's contract:
 * the LLM proposes code changes, the patch workflow validates them deterministically.
 *
 * The workflow is NOT wired into the ResearchAgent today — the agent currently proposes parameter
 * mutations, not code changes. This module is the future-proofing layer for when the agent graduates
 * to code-level proposals ("add a new filter to StructureLiquidityStrategy").
 */

import { exec } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CommandPolicy } from './CommandPolicy.js';

const execAsync = promisify(exec);

/** A request to apply a code patch. */
export interface PatchRequest {
  /** A stable id for the patch run (used in worktree naming + audit). */
  runId: string;
  /** The absolute path to the repository root (where `.git` lives). */
  repoPath: string;
  /** The branch to base the worktree on (usually the current branch). */
  branch: string;
  /** Relative path → new file content. Use empty string to delete the file. */
  files: Record<string, string>;
  /** Validation commands to run after applying the patch. Each must pass the CommandPolicy allowlist. */
  verifyCommands: string[];
  /** Optional commit message for the resulting commit. */
  commitMessage?: string;
}

/** The result of a validation command. */
export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** When the command was denied by the CommandPolicy, this is the reason. */
  deniedReason?: string;
}

/** The result of a patch run. */
export interface PatchResult {
  /** True if all validation commands passed (or there were none). */
  ok: boolean;
  /** The absolute path to the worktree. The operator can `cd` here to review. */
  worktreePath: string;
  /** The git diff of the applied changes (cached, before commit). */
  diff: string;
  /** The commit SHA, when a commit was made. */
  commitSha?: string;
  /** The result of every validation command. */
  verifyResults: VerifyResult[];
  /** When the patch failed, the error message. */
  error?: string;
}

/**
 * The patch workflow. Apply file changes in a git worktree, run validation commands, return the diff.
 *
 * Construction:
 *   - `new PatchWorkflow()` — use the default CommandPolicy.
 *   - `new PatchWorkflow(customPolicy)` — use a custom policy (e.g. a stricter allowlist for CI).
 */
export class PatchWorkflow {
  constructor(private readonly policy: CommandPolicy = new CommandPolicy()) {}

  /**
   * Apply a patch request. Creates a worktree, applies files, optionally commits, runs validations.
   * Returns a PatchResult with the diff + validation results. Never throws — errors are captured in
   * the result so the caller can handle them uniformly.
   */
  async apply(req: PatchRequest): Promise<PatchResult> {
    const worktree = await mkdtemp(join(tmpdir(), `research-patch-${req.runId}-`));
    try {
      // 1. Create a worktree on a temp branch.
      const reviewBranch = `${req.branch}-review-${req.runId}`;
      await execAsync(`git -C ${req.repoPath} worktree add -b ${reviewBranch} ${worktree} ${req.branch}`);

      // 2. Apply file changes.
      for (const [relPath, content] of Object.entries(req.files)) {
        const abs = join(worktree, relPath);
        await mkdir(join(abs, '..'), { recursive: true });
        if (content === '') {
          await execAsync(`rm -f ${JSON.stringify(abs)}`);
        } else {
          await writeFile(abs, content, 'utf8');
        }
      }

      // 3. Stage + produce a diff.
      await execAsync(`git -C ${worktree} add -A`);
      const { stdout: diff } = await execAsync(`git -C ${worktree} diff --cached`);

      // 4. Optionally commit (still on the temp branch).
      let commitSha: string | undefined;
      if (req.commitMessage) {
        await execAsync(
          `git -C ${worktree} -c user.email=research-bot@local -c user.name=ResearchBot commit -m ${JSON.stringify(req.commitMessage)}`,
        );
        const { stdout: sha } = await execAsync(`git -C ${worktree} rev-parse HEAD`);
        commitSha = sha.trim();
      }

      // 5. Run validation commands in the worktree.
      const verifyResults: VerifyResult[] = [];
      let allOk = true;
      for (const cmd of req.verifyCommands) {
        const result = await this.runVerifyCommand(cmd, worktree);
        verifyResults.push(result);
        if (!result.ok) allOk = false;
      }

      if (!allOk) {
        return {
          ok: false,
          worktreePath: worktree,
          diff,
          commitSha,
          verifyResults,
          error: 'one or more verification commands failed',
        };
      }

      return { ok: true, worktreePath: worktree, diff, commitSha, verifyResults };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        worktreePath: worktree,
        diff: '',
        verifyResults: [],
        error: err.message,
      };
    }
  }

  /**
   * Run a single validation command in the worktree. The command is first evaluated against the
   * CommandPolicy; if denied, the result records the denial reason and does not execute.
   */
  private async runVerifyCommand(command: string, worktreePath: string): Promise<VerifyResult> {
    const decision = this.policy.evaluate(command);
    if (!decision.allowed) {
      return {
        command,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        deniedReason: decision.reason,
      };
    }

    const started = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: worktreePath,
        maxBuffer: this.policy.maxOutputBytes,
        timeout: this.policy.timeoutMs,
      });
      return {
        command,
        ok: true,
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message: string; killed?: boolean };
      return {
        command,
        ok: false,
        exitCode: err.code ?? null,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Clean up a worktree. Best-effort: removes the worktree from git and from the filesystem. Safe to
   * call multiple times. The operator should call this after reviewing the patch (or merging it).
   */
  async cleanup(worktreePath: string, repoPath: string): Promise<void> {
    try {
      await execAsync(`git -C ${repoPath} worktree remove --force ${JSON.stringify(worktreePath)}`);
    } catch {
      // best effort — the worktree may have been removed already
    }
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
