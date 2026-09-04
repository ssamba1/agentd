import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface WorktreeResult {
  cwd: string;
  repo: string | null;
  branch: string | null;
  isWorktree: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/**
 * Give a session its own worktree so parallel sessions on one repo cannot
 * fight over the index or stomp each other's files.
 *
 * The branch is created from the repo's current HEAD and left behind when the
 * session ends -- merging is a decision for the operator, not a side effect of
 * a session finishing. `removeWorktree` is the deliberate cleanup.
 *
 * A non-repo path is not an error: the session just runs in a plain directory.
 */
export async function prepareWorkspace(opts: {
  repo?: string | undefined;
  branch?: string | undefined;
  fallbackDir: string;
  sessionId: string;
}): Promise<WorktreeResult> {
  if (!opts.repo) {
    mkdirSync(opts.fallbackDir, { recursive: true });
    return { cwd: opts.fallbackDir, repo: null, branch: null, isWorktree: false };
  }

  if (!(await isGitRepo(opts.repo))) {
    mkdirSync(opts.repo, { recursive: true });
    return { cwd: opts.repo, repo: opts.repo, branch: null, isWorktree: false };
  }

  // Resolve to the repo root so a path pointing at a subdirectory still works.
  const root = await git(opts.repo, ["rev-parse", "--show-toplevel"]);
  const branch = opts.branch ?? `agentd/${opts.sessionId.slice(0, 8)}`;
  const path = opts.fallbackDir;

  try {
    await git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { cwd: path, repo: root, branch, isWorktree: true };
  } catch (err) {
    // Most likely the branch already exists (a resumed session reusing its
    // name). Attaching to it is the right recovery; anything else rethrows.
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(message)) {
      await git(root, ["worktree", "add", path, branch]);
      return { cwd: path, repo: root, branch, isWorktree: true };
    }
    throw new Error(`git worktree add failed for ${root}: ${message}`);
  }
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

export interface DiffSummary {
  files: Array<{ path: string; added: number; removed: number; status: string }>;
  patch: string;
  truncated: boolean;
}

const MAX_PATCH_BYTES = 400_000;

/**
 * What a session actually changed, as structured data rather than a wall of
 * raw diff. The mobile reviewer needs per-file counts to render a list before
 * anyone commits to scrolling a patch on a phone.
 */
export async function diffWorkspace(cwd: string): Promise<DiffSummary> {
  if (!(await isGitRepo(cwd))) return { files: [], patch: "", truncated: false };

  const [numstat, nameStatus, patch] = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat"]).catch(() => ""),
    git(cwd, ["diff", "HEAD", "--name-status"]).catch(() => ""),
    git(cwd, ["diff", "HEAD"]).catch(() => ""),
  ]);

  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split("\t");
    if (status && rest.length) statusByPath.set(rest[rest.length - 1]!, status);
  }

  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      return {
        path: path ?? "",
        // "-" in numstat means a binary file, not zero changes.
        added: added === "-" ? -1 : Number.parseInt(added ?? "0", 10),
        removed: removed === "-" ? -1 : Number.parseInt(removed ?? "0", 10),
        status: statusByPath.get(path ?? "") ?? "M",
      };
    });

  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES;
  return {
    files,
    patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch,
    truncated,
  };
}
