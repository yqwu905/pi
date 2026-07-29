import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  assertGeneratedManifestCurrent,
  hashPath,
  loadBundle,
  MANAGER_RESOURCE_ID,
  parseSemver,
  refreshResourceHashes,
  saveBundle,
  suggestVersion,
  TYPE_TO_PLURAL,
  validateBundle,
  writeGeneratedPackageManifest,
} from "./bundle.mjs";
import { checked, fastForwardPull, inspectGit, output, requirePublishable, requireWritableMain } from "./git.mjs";
import {
  clearPendingSnapshot,
  readPendingSnapshot,
  readRecoveryJournal,
  savePendingSnapshot,
  withRepositoryTransaction,
} from "./transaction.mjs";

const MANAGED_CHANGE_PATHS = [
  "bundle.json",
  "package.json",
  "package-lock.json",
  "vendor/",
  "skills/",
  "prompts/",
  "themes/",
  "third-party/",
];

export async function addCandidate(options) {
  return addCandidates({ ...options, plans: [{
    candidate: options.candidate,
    replaceOwnerIds: options.replaceOwnerIds ?? [],
    renameTo: options.renameTo,
  }] });
}

export async function addCandidates({ root, bundle, plans, run, stateRoot }) {
  await requireWritableMain(root, run, bundle.package.repository, { fetch: true, requireClean: true });
  const result = await withRepositoryTransaction(root, "add", async () => {
    const next = structuredClone(bundle);
    for (const plan of plans) {
      for (const ownerId of plan.replaceOwnerIds ?? []) {
        const removed = removeManagedUnit(next, ownerId);
        if (removed) await removeManagedFiles(root, removed);
      }
      const { candidate } = plan;
      if (candidate.kind === "package") {
        const record = structuredClone(candidate.record);
        const existingIndex = next.packages.findIndex((pkg) => pkg.id === record.id);
        const existingRecord = existingIndex >= 0 ? next.packages[existingIndex] : undefined;
        if (existingRecord?.vendorRoot && existingRecord.vendorRoot !== record.vendorRoot) {
          const oldPath = resolve(root, existingRecord.vendorRoot);
          assertDestructivePath(root, oldPath, ["vendor/packages/"]);
          await rm(oldPath, { recursive: true, force: true });
        }
        if (!record.dependency) {
          await rm(join(root, record.vendorRoot), { recursive: true, force: true });
          await copyTree(candidate.installedRoot, join(root, record.vendorRoot));
          delete record.originalRoot;
        }
        if (existingIndex >= 0) next.packages[existingIndex] = record;
        else next.packages.push(record);
      } else {
        const record = await vendorResource(root, candidate, plan.renameTo);
        const existingIndex = next.resources.findIndex((resource) => resource.id === record.id);
        if (existingIndex >= 0) next.resources[existingIndex] = record;
        else next.resources.push(record);
      }
    }

    sortBundle(next);
    await refreshResourceHashes(root, next);
    await saveBundle(root, next);
    await writeGeneratedPackageManifest(root, next);
    await installAndCheck(root, run);
    return next;
  }, { stateRoot });
  if (stateRoot) await savePendingSnapshot(root, stateRoot);
  return result;
}

export async function removeUnit(options) {
  const result = await removeUnits({ ...options, unitIds: [options.unitId] });
  return { bundle: result.bundle, removed: result.removed[0] };
}

export async function removeUnits({ root, bundle, unitIds, run, stateRoot }) {
  await requireWritableMain(root, run, bundle.package.repository, { fetch: true, requireClean: true });
  const result = await withRepositoryTransaction(root, "remove", async () => {
    const next = structuredClone(bundle);
    const removed = [];
    for (const unitId of unitIds) {
      const item = removeManagedUnit(next, unitId);
      if (!item) throw new Error(`Unknown managed unit: ${unitId}`);
      removed.push(item);
      await removeManagedFiles(root, item);
    }
    sortBundle(next);
    await refreshResourceHashes(root, next);
    await saveBundle(root, next);
    await writeGeneratedPackageManifest(root, next);
    await installAndCheck(root, run);
    return { bundle: next, removed };
  }, { stateRoot });
  if (stateRoot) await savePendingSnapshot(root, stateRoot);
  return result;
}

export function removeManagedUnit(bundle, unitId) {
  const packageIndex = bundle.packages.findIndex((pkg) => pkg.id === unitId);
  if (packageIndex >= 0) return { kind: "package", value: bundle.packages.splice(packageIndex, 1)[0] };
  const resourceIndex = bundle.resources.findIndex((resource) => resource.id === unitId);
  if (resourceIndex < 0) return undefined;
  if (bundle.resources[resourceIndex].protected || unitId === MANAGER_RESOURCE_ID) {
    throw new Error(`${unitId} is protected and cannot be removed`);
  }
  return { kind: "resource", value: bundle.resources.splice(resourceIndex, 1)[0] };
}

export async function reviewPackage({ root, bundle, run }) {
  validateBundle(bundle, root);
  await assertGeneratedManifestCurrent(root, bundle);
  const git = await inspectGit(root, run, { fetch: false });
  const trackedDiff = await output(run, "git", ["diff", "--", "."], root);
  const untrackedPreview = await previewUntrackedManagedFiles(root, run);
  const diff = [trackedDiff, untrackedPreview].filter(Boolean).join("\n");
  const statText = await output(run, "git", ["diff", "--stat", "--", "."], root);
  const unrelatedChanges = await findUnmanagedChanges(root, run);
  return {
    git,
    diff,
    stat: statText,
    suggestedChange: classifyPendingChange(diff),
    suggestedVersion: suggestVersion(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, classifyPendingChange(diff)),
    unrelatedChanges,
  };
}

export async function pullPackage({ root, bundle, run }) {
  await fastForwardPull(root, run, bundle.package.repository);
  await installAndCheck(root, run);
}

export async function publishPackage({ root, bundle, version, run, stateRoot }) {
  await requirePublishable(root, run, bundle.package.repository);
  const unrelatedChanges = await findUnmanagedChanges(root, run);
  if (unrelatedChanges.length > 0) {
    throw new Error(`Refusing to publish unrelated checkout changes: ${unrelatedChanges.join(", ")}`);
  }
  const sensitiveFiles = await findSensitiveManagedFiles(root, run);
  if (sensitiveFiles.length > 0) {
    throw new Error(`Refusing to publish potentially sensitive files: ${sensitiveFiles.join(", ")}`);
  }
  await checked(run, "gh", ["auth", "status"], root);
  await checked(run, "gh", ["repo", "view", "yqwu905/pi", "--json", "nameWithOwner"], root);
  parseSemver(version);
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertVersionIncrease(manifest.version, version);
  const tag = `v${version}`;
  const existingTag = await run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: root });
  if (existingTag.code === 0) throw new Error(`Tag already exists: ${tag}`);
  const remoteTag = await run("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], { cwd: root });
  if (remoteTag.code === 0) throw new Error(`Remote tag already exists: ${tag}`);
  const existingRelease = await run("gh", ["release", "view", tag, "--repo", "yqwu905/pi"], { cwd: root });
  if (existingRelease.code === 0) throw new Error(`GitHub Release already exists: ${tag}`);

  await withRepositoryTransaction(root, "publish-prepare", async () => {
    manifest.version = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await checked(run, "npm", ["install"], root);
    await runFullValidation(root, run);
  }, { stateRoot });

  await checked(run, "git", ["add", "-A", "--", "."], root);
  await checked(run, "git", ["diff", "--cached", "--check"], root);
  await checked(run, "git", ["commit", "-m", `Release Pi bundle ${tag}`], root);
  await checked(run, "git", ["tag", "-a", tag, "-m", tag], root);
  await checked(run, "git", ["push", "--atomic", "origin", "main", tag], root);
  await checked(run, "gh", ["release", "create", tag, "--repo", "yqwu905/pi", "--generate-notes", "--title", tag], root);
  if (stateRoot) await clearPendingSnapshot(stateRoot);
  return { tag };
}

export async function doctorPackage({ root, bundle, run, managedInstall, stateRoot }) {
  const checks = [];
  await capture(checks, "bundle schema", async () => validateBundle(bundle, root));
  await capture(checks, "generated package.json", async () => assertGeneratedManifestCurrent(root, bundle));
  await capture(checks, "resource hashes", async () => {
    for (const resource of bundle.resources) {
      const actual = await hashPath(resolve(root, resource.contentRoot ?? resource.path));
      if (actual !== resource.sha256) throw new Error(`${resource.id} content differs from bundle.json`);
    }
  });
  await capture(checks, "protected manager", async () => {
    const manager = bundle.resources.find((resource) => resource.id === MANAGER_RESOURCE_ID);
    await stat(resolve(root, manager.path));
  });
  await capture(checks, "managed checkout", async () => {
    if (!managedInstall) throw new Error("Package is not running from Pi's managed install path");
  });
  await capture(checks, "Git main/origin", async () => {
    const state = await inspectGit(root, run, { fetch: false });
    if (state.detached || state.branch !== "main") throw new Error("detached or non-main checkout");
    if (state.diverged) throw new Error("main diverged from origin/main");
  });
  await capture(checks, "gh authentication", async () => checked(run, "gh", ["auth", "status"], root));
  await capture(checks, "current GitHub release", async () => {
    const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    await checked(run, "gh", ["release", "view", `v${version}`, "--repo", "yqwu905/pi"], root);
  });
  await capture(checks, "npm dependency tree", async () => checked(run, "npm", ["ls", "--depth=0"], root));
  await capture(checks, "security audit", async () => checked(run, "npm", ["audit", "--omit=dev", "--registry=https://registry.npmjs.org"], root));
  const journal = await readRecoveryJournal(root, stateRoot);
  if (journal) checks.push({ name: "transaction journal", ok: false, detail: `interrupted ${journal.action} from ${journal.startedAt}` });
  else checks.push({ name: "transaction journal", ok: true });
  if (stateRoot) {
    try {
      await stat(join(stateRoot, "lock"));
      checks.push({ name: "operation lock", ok: false, detail: `stale or active lock at ${join(stateRoot, "lock")}` });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      checks.push({ name: "operation lock", ok: true });
    }
  }
  const pending = stateRoot ? await readPendingSnapshot(stateRoot) : undefined;
  checks.push({
    name: "external pending backup",
    ok: !pending,
    ...(pending ? { detail: `saved ${pending.savedAt}; preserve it until pending changes are published` } : {}),
  });
  return checks;
}

export async function runFullValidation(root, run) {
  await checked(run, "npm", ["run", "check"], root);
  await checked(run, "npm", ["test"], root);
  await checked(run, "npm", ["audit", "--omit=dev", "--registry=https://registry.npmjs.org"], root);
  await checked(run, "git", ["diff", "--check"], root);
  const temporaryAgentDir = await mkdtemp(join(tmpdir(), "pi-package-validate-"));
  try {
    const loaded = await checked(
      run,
      "env",
      [`PI_CODING_AGENT_DIR=${temporaryAgentDir}`, "pi", "--verbose", "-e", root, "--list-models"],
      root,
      { timeout: 120000 },
    );
    if (loaded.stderr.trim()) throw new Error(`Prospective Pi load reported errors: ${loaded.stderr.trim()}`);
  } finally {
    await rm(temporaryAgentDir, { recursive: true, force: true });
  }
}

export async function installAndCheck(root, run) {
  await checked(run, "npm", ["install"], root);
  await checked(run, "npm", ["run", "check"], root);
}

export function classifyPendingChange(diff) {
  return /(?:^|\n)[+-]\s*"(?:id|name|path|installSource)"/u.test(diff) || /(?:^|\n)[+-].*(?:packages|resources)/u.test(diff)
    ? "minor"
    : "patch";
}

async function vendorResource(root, candidate, renameTo) {
  if (renameTo && candidate.type === "extension") {
    throw new Error("Extensions cannot be safely renamed because their runtime command/tool names may still collide");
  }
  const name = renameTo || candidate.name;
  const plural = TYPE_TO_PLURAL[candidate.type];
  const destinationBase = `vendor/${plural}/${safeName(name)}`;
  let destination = resolve(root, destinationBase);
  let entryPath;
  const sourceInfo = await stat(candidate.copyRoot);
  if (sourceInfo.isDirectory()) {
    await rm(destination, { recursive: true, force: true });
    await copyTree(candidate.copyRoot, destination);
    entryPath = candidate.type === "skill" ? destinationBase : joinPosix(destinationBase, candidate.entryRelative);
  } else {
    const extension = extname(candidate.copyRoot);
    if (candidate.type === "extension") {
      const extensionRoot = resolve(root, destinationBase);
      await rm(extensionRoot, { recursive: true, force: true });
      await mkdir(extensionRoot, { recursive: true });
      destination = join(extensionRoot, basename(candidate.copyRoot));
      await cp(candidate.copyRoot, destination);
      for (const supportFile of candidate.supportFiles ?? []) {
        const relativeSupport = relative(dirname(candidate.copyRoot), supportFile);
        const supportDestination = resolve(extensionRoot, relativeSupport);
        if (!isInside(extensionRoot, supportDestination)) throw new Error(`Extension support file escapes vendor root: ${supportFile}`);
        await mkdir(dirname(supportDestination), { recursive: true });
        await cp(supportFile, supportDestination);
      }
      entryPath = toPosix(relative(root, destination));
    } else {
      const fileName = `${safeName(name)}${extension}`;
      destination = resolve(root, "vendor", plural, fileName);
      await mkdir(dirname(destination), { recursive: true });
      await cp(candidate.copyRoot, destination);
      entryPath = toPosix(relative(root, destination));
    }
  }

  if (renameTo) await rewriteSemanticName(candidate.type, resolve(root, entryPath), renameTo);
  const usesDirectoryRoot = sourceInfo.isDirectory() || candidate.type === "extension";
  const hashRoot = usesDirectoryRoot ? resolve(root, destinationBase) : resolve(root, entryPath);
  return {
    id: `${candidate.type}:${name}`,
    type: candidate.type,
    name,
    path: toPosix(entryPath),
    ...(usesDirectoryRoot ? { contentRoot: destinationBase } : {}),
    source: {
      type: "local-vendor",
      originalPath: candidate.copyRoot,
      scope: candidate.metadata.scope,
      source: candidate.metadata.source,
    },
    sha256: await hashPath(hashRoot),
  };
}

async function rewriteSemanticName(type, path, name) {
  if (type === "skill") {
    const skillFile = basename(path) === "SKILL.md" ? path : join(path, "SKILL.md");
    const content = await readFile(skillFile, "utf8");
    await writeFile(skillFile, content.replace(/^name:\s*.*$/mu, `name: ${name}`));
  } else if (type === "theme") {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.name = name;
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

function removeManagedUnitByValue(bundle, value) {
  return removeManagedUnit(bundle, value.id);
}

async function removeManagedFiles(root, removed) {
  if (removed.kind === "resource" && removed.value.path) {
    const path = resolve(root, removed.value.contentRoot ?? removed.value.path);
    assertDestructivePath(root, path, ["vendor/", "skills/", "prompts/", "themes/"]);
    if (!removed.value.protected) await rm(path, { recursive: true, force: true });
  }
  if (removed.kind === "package" && removed.value.vendorRoot) {
    const path = resolve(root, removed.value.vendorRoot);
    assertDestructivePath(root, path, ["vendor/packages/"]);
    await rm(path, { recursive: true, force: true });
  }
}

function assertDestructivePath(root, path, allowedPrefixes) {
  const rel = toPosix(relative(resolve(root), resolve(path)));
  if (!rel || rel === "." || rel.startsWith("../") || !allowedPrefixes.some((prefix) => rel.startsWith(prefix))) {
    throw new Error(`Refusing unsafe destructive path: ${path}`);
  }
}

export async function previewUntrackedManagedFiles(root, run) {
  const files = await untrackedFiles(root, run);
  const previews = [];
  for (const path of files.filter(isManagedChangePath)) {
    const absolute = resolve(root, path);
    const content = await readFile(absolute);
    if (content.includes(0)) {
      previews.push(`--- /dev/null\n+++ b/${path}\nBinary file added (${content.length} bytes)`);
      continue;
    }
    const text = content.toString("utf8");
    const limited = text.length > 65536 ? `${text.slice(0, 65536)}\n[preview truncated]` : text;
    previews.push(`--- /dev/null\n+++ b/${path}\n${limited.split("\n").map((line) => `+${line}`).join("\n")}`);
  }
  return previews.join("\n");
}

export async function findSensitiveManagedFiles(root, run) {
  const status = await changedFiles(root, run);
  const sensitive = [];
  const sensitiveName = /(?:^|\/)(?:\.env(?:\..+)?|auth\.json|credentials?(?:\.json)?|id_rsa|[^/]+\.(?:pem|key))$/iu;
  const secretContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-ant-[a-z0-9_-]+|\bghp_[a-zA-Z0-9]+|\bgithub_pat_[a-zA-Z0-9_]+|["'](?:access_token|refresh_token|client_secret)["']\s*:/u;
  for (const path of status.filter(isManagedChangePath)) {
    if (sensitiveName.test(path)) {
      sensitive.push(path);
      continue;
    }
    try {
      const content = await readFile(resolve(root, path), "utf8");
      if (secretContent.test(content)) sensitive.push(path);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EISDIR") throw error;
    }
  }
  return sensitive;
}

export async function findUnmanagedChanges(root, run) {
  const status = (await checked(run, "git", ["status", "--porcelain=v1", "--untracked-files=all"], root)).stdout.trimEnd();
  if (!status) return [];
  return parseStatusPaths(status).filter((path) => !isManagedChangePath(path));
}

async function changedFiles(root, run) {
  const status = (await checked(run, "git", ["status", "--porcelain=v1", "--untracked-files=all"], root)).stdout.trimEnd();
  return status ? parseStatusPaths(status) : [];
}

async function untrackedFiles(root, run) {
  const result = await output(run, "git", ["ls-files", "--others", "--exclude-standard"], root);
  return result ? result.split("\n").filter(Boolean) : [];
}

function parseStatusPaths(status) {
  return status
    .split("\n")
    .map((line) => line.slice(3).replace(/^"|"$/gu, ""))
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1) : path);
}

function isManagedChangePath(path) {
  return MANAGED_CHANGE_PATHS.some((allowed) => allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed);
}

function sortBundle(bundle) {
  bundle.packages.sort((left, right) => left.id.localeCompare(right.id));
  bundle.resources.sort((left, right) => {
    if (left.protected && !right.protected) return -1;
    if (!left.protected && right.protected) return 1;
    return left.id.localeCompare(right.id);
  });
}

async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:^|[\\/])(?:node_modules|\.git|sessions)(?:[\\/]|$)/u.test(path) &&
      !/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|auth\.json|credentials?(?:\.json)?|id_rsa|[^\\/]+\.(?:pem|key))$/iu.test(path) &&
      !path.endsWith(".DS_Store"),
  });
}

function assertVersionIncrease(current, next) {
  const left = parseSemver(current);
  const right = parseSemver(next);
  const increases =
    right.major > left.major ||
    (right.major === left.major && right.minor > left.minor) ||
    (right.major === left.major && right.minor === left.minor && right.patch > left.patch);
  if (!increases) throw new Error(`Version must increase beyond ${current}`);
}

async function capture(results, name, operation) {
  try {
    await operation();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function safeName(value) {
  const result = value.replace(/^@/u, "").replace(/[^a-zA-Z0-9._-]+/gu, "-");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(result)) throw new Error(`Unsafe resource name: ${value}`);
  return result;
}

function joinPosix(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/gu, "/");
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}
