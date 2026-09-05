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

  // `git diff HEAD` does not see untracked files, so a session whose whole
  // contribution is new files would show an empty diff. Reviewing changes and
  // silently missing every added file is the worst way for this to be wrong,
  // so untracked paths are folded in explicitly.
  //
  // --intent-to-add would be simpler but mutates the index, and this is a
  // read-only view of someone else's working tree.
  const [numstat, nameStatus, tracked, untrackedList] = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat"]).catch(() => ""),
    git(cwd, ["diff", "HEAD", "--name-status"]).catch(() => ""),
    git(cwd, ["diff", "HEAD"]).catch(() => ""),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
  ]);

  const untracked = untrackedList.split("\n").filter(Boolean);
  const extraPatches: string[] = [];
  const extraFiles: DiffSummary["files"] = [];
  for (const path of untracked.slice(0, 200)) {
    // --no-index against the null device produces a normal-looking patch for a
    // file git does not track yet. It exits non-zero when there is a
    // difference, which is the expected case, so failure is not an error here.
    const patch = await git(cwd, ["diff", "--no-index", "--", NULL_DEVICE, path]).catch(
      (err: { stdout?: string }) => err.stdout ?? "",
    );
    const added = patch ? patch.split("\n").filter((l) => l.startsWith("+")).length - 1 : 0;
    extraFiles.push({ path, added: Math.max(0, added), removed: 0, status: "A" });
    if (patch) extraPatches.push(normalizeNoIndexPatch(patch, path));
  }
  const patch = [tracked, ...extraPatches].filter(Boolean).join("\n");

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
    files: [...files, ...extraFiles],
    patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch,
    truncated: truncated || untracked.length > 200,
  };
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * `git diff --no-index` writes the null device as the "a" side, which the
 * client's per-file patch splitter cannot map back to a path. Rewrite the
 * header so an untracked file reads like any other addition.
 */
function normalizeNoIndexPatch(patch: string, path: string): string {
  const body = patch.split("\n").slice(1).join("\n");
  return `diff --git a/${path} b/${path}\n${body}`;
}
