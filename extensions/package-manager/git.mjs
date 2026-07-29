export async function inspectGit(root, run, options = {}) {
  if (options.fetch) await checked(run, "git", ["fetch", "origin", "--tags"], root);
  const branch = await output(run, "git", ["branch", "--show-current"], root);
  const head = await output(run, "git", ["rev-parse", "HEAD"], root);
  const remoteHead = await optionalOutput(run, "git", ["rev-parse", "origin/main"], root);
  const origin = await optionalOutput(run, "git", ["remote", "get-url", "origin"], root);
  const status = await output(run, "git", ["status", "--porcelain"], root);
  const aheadBehind = remoteHead
    ? await output(run, "git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"], root)
    : "0\t0";
  const [behind = 0, ahead = 0] = aheadBehind.split(/\s+/u).map(Number);
  return {
    branch,
    detached: branch.length === 0,
    head,
    remoteHead,
    origin,
    dirty: status.length > 0,
    status,
    ahead,
    behind,
    diverged: ahead > 0 && behind > 0,
  };
}

export async function requireWritableMain(root, run, expectedRepository, options = {}) {
  const state = await inspectGit(root, run, { fetch: options.fetch ?? true });
  if (state.detached || state.branch !== "main") {
    throw new Error("Package management writes require an unpinned rolling install on branch main");
  }
  if (!sameRepository(state.origin, expectedRepository)) {
    throw new Error(`Unexpected origin remote: ${state.origin || "(missing)"}`);
  }
  if (!state.remoteHead) throw new Error("origin/main is unavailable");
  if (state.head !== state.remoteHead) {
    throw new Error("Local main and origin/main differ. Resolve or pull before modifying the package");
  }
  if (options.requireClean !== false && state.dirty) {
    throw new Error("Package checkout has pending changes. Publish, review, or discard them first");
  }
  return state;
}

export async function requirePublishable(root, run, expectedRepository) {
  const state = await requireWritableMain(root, run, expectedRepository, { fetch: true, requireClean: false });
  if (!state.dirty) throw new Error("There are no package changes to publish");
  return state;
}

export async function fastForwardPull(root, run, expectedRepository) {
  const state = await inspectGit(root, run, { fetch: true });
  if (state.detached || state.branch !== "main") {
    throw new Error("Package pull requires an unpinned rolling install on branch main");
  }
  if (!sameRepository(state.origin, expectedRepository)) {
    throw new Error(`Unexpected origin remote: ${state.origin || "(missing)"}`);
  }
  if (state.dirty) throw new Error("Package checkout has pending changes; pull will not overwrite them");
  if (state.ahead > 0 || state.diverged) throw new Error("Local main contains unpublished commits; pull stopped");
  await checked(run, "git", ["merge", "--ff-only", "origin/main"], root);
}

export async function checked(run, command, args, cwd, options = {}) {
  const result = await run(command, args, { cwd, ...options });
  if (result.code !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export async function output(run, command, args, cwd) {
  return (await checked(run, command, args, cwd)).stdout.trim();
}

async function optionalOutput(run, command, args, cwd) {
  const result = await run(command, args, { cwd });
  return result.code === 0 ? result.stdout.trim() : "";
}

export function sameRepository(left, right) {
  return normalizeRepository(left) === normalizeRepository(right);
}

export function normalizeRepository(value = "") {
  let normalized = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/u, "https://$1/")
    .replace(/^ssh:\/\/git@/u, "https://")
    .replace(/^git:/u, "");
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//iu.test(normalized)) normalized = `https://${normalized}`;
  return normalized
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "")
    .toLowerCase();
}
