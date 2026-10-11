/**
 * Command policy — adapted from agent-tui's `supervisor/sandbox/policy.ts` pattern.
 *
 * Allowlist/denylist gate for shell commands. The ResearchAgent's code-mutation path runs validation
 * commands (`npm run typecheck`, `npm test`, etc.) in a git worktree; the CommandPolicy is the safety
 * layer that prevents an LLM-proposed command from doing `rm -rf data/` or `git push --force`.
 *
 * The policy is intentionally conservative:
 *   - Denylist always wins (a command matching both lists is denied).
 *   - Empty commands are denied.
 *   - Commands must match an allowlist entry to be permitted.
 *
 * The default allowlist covers the validation commands the research plane needs (npm test, tsc, biome,
 * tsx, git status/log/diff). The default denylist blocks destructive commands (rm -rf, mkfs, dd, sudo,
 * git push --force, git reset --hard, fork bombs, shutdown, reboot).
 *
 * The policy is pure: same command → same decision. No I/O, no side effects.
 */

/** The result of evaluating a command against the policy. */
export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable reason for the decision (for logging/audit). */
  reason?: string;
  /** The allowlist regex that matched, when allowed. */
  matchedAllow?: string;
  /** The denylist regex that matched, when denied. */
  matchedDeny?: string;
}

/** Default allowlist — read-only commands + validation commands the research plane needs. */
export const DEFAULT_ALLOWLIST: readonly RegExp[] = [
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^find(\s|$)/,
  /^wc(\s|$)/,
  /^sort(\s|$)/,
  /^uniq(\s|$)/,
  /^diff(\s|$)/,
  /^git\s+(status|log|diff|show|branch|blame|stash\s+list)/,
  /^npm\s+(test|run\s+test|ci|run\s+typecheck|run\s+build|run\s+research:golden)/,
  /^npx\s+(tsx|tsc)\s/,
  /^node\s+--test(\s|$)/,
  /^tsc(\s|$)/,
  /^biome\s+check(\s|$)/,
  /^tsx\s+/,
  /^echo(\s|$)/,
  /^pwd(\s|$)/,
  /^env(\s|$)/,
];

/** Default denylist — destructive commands that must never run. */
export const DEFAULT_DENYLIST: readonly RegExp[] = [
  /\brm\s+-rf?\s+/,
  /:\(\)\s*\{\s*:\|:&\s*\}\};:/, // fork bomb
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /curl\s+.*\|\s*(sh|bash|zsh)/,
  /\bwget\s+.*\|\s*(sh|bash|zsh)/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  /\bdocker\s+(push|rm|kill|stop|rmi)/,
  /\bkubectl\s+(delete|edit|apply)\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\b/,
  />\/dev\/(sd|nvme|disk)/,
  /\bnc\s+-l\b/,
  /\bshutdown\b/,
  /\breboot\b/,
];

/**
 * Command policy. Allowlist/denylist gate for shell commands.
 *
 * Construction:
 *   - `new CommandPolicy()` — use defaults.
 *   - `new CommandPolicy(customAllow, customDeny)` — override either list.
 *   - `new CommandPolicy(allow, deny, { allowedCwd, maxOutputBytes, timeoutMs })` — full control.
 */
export class CommandPolicy {
  constructor(
    private readonly allowlist: readonly RegExp[] = DEFAULT_ALLOWLIST,
    private readonly denylist: readonly RegExp[] = DEFAULT_DENYLIST,
    private readonly opts: {
      allowedCwd?: string;
      maxOutputBytes?: number;
      timeoutMs?: number;
      allowedEnvPrefixes?: string[];
    } = {},
  ) {}

  /** Evaluate a command against the policy. Pure: same command → same decision. */
  evaluate(command: string): PolicyDecision {
    const trimmed = command.trim();
    if (!trimmed) return { allowed: false, reason: 'empty command' };

    // Denylist first — deny always wins.
    for (const re of this.denylist) {
      if (re.test(trimmed)) {
        return {
          allowed: false,
          matchedDeny: re.source,
          reason: `denylist match: ${re.source.slice(0, 80)}`,
        };
      }
    }

    // Allowlist — must match at least one entry.
    let matchedAllow: string | undefined;
    const allowed = this.allowlist.some((re) => {
      if (re.test(trimmed)) {
        matchedAllow = re.source;
        return true;
      }
      return false;
    });
    if (!allowed) {
      return { allowed: false, reason: 'not on allowlist' };
    }
    return { allowed: true, matchedAllow };
  }

  /** Validate env vars before they reach a subprocess. Returns allowed + blocked. */
  evaluateEnv(env: Record<string, string>): { allowed: Record<string, string>; blocked: string[] } {
    const prefixes = this.opts.allowedEnvPrefixes ?? ['PATH', 'HOME', 'LANG', 'LC_', 'NODE_', 'CI_'];
    const allowed: Record<string, string> = {};
    const blocked: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (prefixes.some((p) => k === p || k.startsWith(p))) {
        allowed[k] = v;
      } else {
        blocked.push(k);
      }
    }
    return { allowed, blocked };
  }

  get maxOutputBytes(): number { return this.opts.maxOutputBytes ?? 1024 * 1024; }
  get timeoutMs(): number { return this.opts.timeoutMs ?? 60_000; }
  get allowedCwd(): string | undefined { return this.opts.allowedCwd; }
}
