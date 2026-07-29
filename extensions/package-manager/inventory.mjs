import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { hashPath, PLURAL_TO_TYPE, resourceOwners, semanticName } from "./bundle.mjs";
import { normalizeRepository, output } from "./git.mjs";

export async function discoverCandidates({ root, agentDir, bundle, packageManager, run }) {
  const configured = packageManager.listConfiguredPackages();
  const resolved = await packageManager.resolve(async () => "skip");
  const allResources = await Promise.all(
    flattenResolved(resolved).map(async (resource) => ({
      ...resource,
      path: (await safeRealpath(resource.path)) ?? resource.path,
    })),
  );
  const rootReal = await realpath(root);
  const candidates = [];
  const packageRoots = [];

  for (const configuredPackage of configured) {
    if (!configuredPackage.installedPath) continue;
    const installedReal = await safeRealpath(configuredPackage.installedPath);
    if (!installedReal) continue;
    if (installedReal === rootReal) {
      packageRoots.push(installedReal);
      continue;
    }
    const installedInfo = await stat(installedReal);
    const unfiltered = await packageManager.resolveExtensionSources([configuredPackage.source], {
      local: configuredPackage.scope === "project",
    });
    const packageResources = await Promise.all(
      flattenResolved(unfiltered)
        .filter((resource) => resource.metadata.origin === "package" && resource.enabled)
        .map(async (resource) => ({
          ...resource,
          path: (await safeRealpath(resource.path)) ?? resource.path,
        })),
    );
    const ownedResources = packageResources.filter((resource) => isInside(installedReal, resource.path));
    if (installedInfo.isFile()) {
      for (const resource of ownedResources.filter((item) => item.path === installedReal)) {
        const candidate = await localResourceCandidate(resource);
        if (candidate) candidates.push(candidate);
      }
      continue;
    }
    packageRoots.push(installedReal);
    const candidate = await packageCandidate(configuredPackage, installedReal, ownedResources, run);
    if (candidate) candidates.push(candidate);
  }

  for (const resource of allResources) {
    if (resource.metadata.origin !== "top-level" || !resource.enabled) continue;
    if (isInside(rootReal, resource.path)) continue;
    if (packageRoots.some((packageRoot) => isInside(packageRoot, resource.path))) continue;
    const candidate = await localResourceCandidate(resource);
    if (candidate) candidates.push(candidate);
  }

  const existingPackages = new Map(bundle.packages.map((pkg) => [pkg.id, pkg]));
  const owners = resourceOwners(bundle);
  const result = [];
  for (const candidate of dedupeCandidates(candidates)) {
    if (candidate.kind === "package") {
      const existing = existingPackages.get(candidate.id);
      if (existing && sameResolvedPackage(existing, candidate.record)) continue;
      result.push({
        ...candidate,
        action: existing ? "update" : "add",
        conflicts: findConflicts(candidate.semanticResources, owners, existing?.id),
      });
      continue;
    }

    const owner = owners.get(candidate.semanticId);
    if (!owner) {
      result.push({ ...candidate, action: "add", conflicts: [] });
      continue;
    }
    const existing = bundle.resources.find((resource) => resource.id === owner.id);
    if (existing?.sha256 && existing.sha256 === candidate.sha256) continue;
    result.push({ ...candidate, action: "conflict", conflicts: [{ semanticId: candidate.semanticId, owner }] });
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}

export function flattenResolved(resolved) {
  const result = [];
  for (const [plural, entries] of Object.entries(resolved)) {
    const type = PLURAL_TO_TYPE[plural];
    if (!type) continue;
    for (const entry of entries) result.push({ ...entry, type });
  }
  return result;
}

export async function semanticResource(type, path) {
  if (type === "skill") return { type, name: await skillName(path), semanticId: `skill:${await skillName(path)}` };
  if (type === "theme") {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const name = typeof parsed.name === "string" ? parsed.name : semanticName(type, path);
    return { type, name, semanticId: `theme:${name}` };
  }
  const name = semanticName(type, path);
  return { type, name, semanticId: `${type}:${name}` };
}

export function packageIdentity(source) {
  if (source.startsWith("npm:")) return `npm:${npmPackageName(source.slice(4))}`;
  if (source.startsWith("git:") || /^(?:https?|ssh|git):\/\//u.test(source)) {
    return `git:${normalizeGitSource(source)}`;
  }
  return `local:${resolve(source)}`;
}

export function npmPackageName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionSeparator = spec.lastIndexOf("@");
    return versionSeparator > slash ? spec.slice(0, versionSeparator) : spec;
  }
  const versionSeparator = spec.lastIndexOf("@");
  return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
}

export function candidateSummary(candidate) {
  if (candidate.kind === "package") {
    const counts = Object.entries(candidate.record.resources)
      .filter(([, paths]) => paths.length > 0)
      .map(([type, paths]) => `${paths.length} ${type}`)
      .join(", ");
    return `${candidate.record.source.type} package; ${counts || "no enabled resources"}`;
  }
  return `${candidate.type} from ${candidate.originalPath}`;
}

async function packageCandidate(configuredPackage, installedRoot, resources, run) {
  if (resources.length === 0) return undefined;
  const manifestPath = join(installedRoot, "package.json");
  const manifest = await optionalJson(manifestPath);
  const id = packageIdentity(configuredPackage.source);
  const grouped = Object.fromEntries(["extensions", "skills", "prompts", "themes"].map((type) => [type, []]));
  const semantics = [];
  for (const resource of resources) {
    const relativePath = toPosix(relative(installedRoot, resource.path));
    grouped[`${resource.type}s`].push(relativePath);
    semantics.push(await semanticResource(resource.type, resource.path));
  }
  for (const paths of Object.values(grouped)) paths.sort();

  const sourceType = sourceKind(configuredPackage.source);
  const record = {
    id,
    installSource: configuredPackage.source,
    scope: configuredPackage.scope,
    source: { type: sourceType },
    resources: grouped,
    identities: semantics.map(({ type, name }) => ({ type, name })),
    license: typeof manifest?.license === "string" ? manifest.license : "UNKNOWN",
  };

  if (sourceType === "npm") {
    if (!manifest?.name || !manifest?.version) throw new Error(`${configuredPackage.source}: invalid npm package manifest`);
    record.source.name = manifest.name;
    record.source.version = manifest.version;
    record.dependency = { name: manifest.name, spec: manifest.version };
    record.resolved = manifest.version;
  } else if (sourceType === "git" && manifest?.name) {
    const commit = await output(run, "git", ["rev-parse", "HEAD"], installedRoot);
    const remote = await output(run, "git", ["remote", "get-url", "origin"], installedRoot);
    const repository = dependencyGitUrl(remote);
    record.source.repository = normalizeRepository(remote);
    record.source.commit = commit;
    record.dependency = { name: manifest.name, spec: `${repository}#${commit}` };
    record.resolved = commit;
  } else {
    record.source.type = sourceType === "git" ? "git-vendor" : "local";
    record.source.originalPath = installedRoot;
    if (sourceType === "git") {
      record.source.repository = normalizeRepository(await output(run, "git", ["remote", "get-url", "origin"], installedRoot));
      record.source.commit = await output(run, "git", ["rev-parse", "HEAD"], installedRoot);
    }
    record.vendorRoot = `vendor/packages/${safeName(manifest?.name ?? basename(installedRoot))}`;
    record.originalRoot = installedRoot;
  }

  return {
    kind: "package",
    id,
    label: `${id}${record.resolved ? ` @ ${record.resolved.slice(0, 12)}` : ""}`,
    record,
    installedRoot,
    semanticResources: semantics,
    configuredPackage,
  };
}

async function localResourceCandidate(resource) {
  const semantic = await semanticResource(resource.type, resource.path);
  const copyRoot = await localCopyRoot(resource.type, resource.path);
  const supportFiles = resource.type === "extension" && (await stat(copyRoot)).isFile()
    ? await discoverExtensionSupportFiles(copyRoot)
    : [];
  return {
    kind: "resource",
    id: semantic.semanticId,
    semanticId: semantic.semanticId,
    type: resource.type,
    name: semantic.name,
    label: `${semantic.semanticId} — ${resource.path}`,
    originalPath: resource.path,
    copyRoot,
    entryRelative: toPosix(relative(copyRoot, resource.path)),
    supportFiles,
    sha256: await hashPath(copyRoot),
    metadata: resource.metadata,
  };
}

async function discoverExtensionSupportFiles(entry) {
  const root = dirname(entry);
  const discovered = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    const content = await readFile(current, "utf8");
    const pattern = /(?:from\s*|import\s+|import\s*\(|require\s*\(|new\s+URL\s*\()\s*["']([^"']+)["']/gu;
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      if (specifier.startsWith("../")) {
        throw new Error(`Local extension ${entry} imports outside its directory (${specifier}); package it in its own directory before importing`);
      }
      const resolved = await resolveLocalImport(root, specifier);
      if (!resolved || resolved === entry || discovered.has(resolved)) continue;
      discovered.add(resolved);
      if (/\.(?:ts|js|mjs|cjs)$/u.test(resolved)) queue.push(resolved);
    }
  }
  return [...discovered].sort();
}

async function resolveLocalImport(root, specifier) {
  const base = resolve(root, specifier);
  for (const candidate of [
    base,
    `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    join(base, "index.ts"), join(base, "index.js"), join(base, "index.mjs"), join(base, "index.cjs"),
  ]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Unable to resolve local extension import ${specifier} from ${root}`);
}

async function localCopyRoot(type, path) {
  const info = await stat(path);
  if (type === "skill") return info.isDirectory() ? path : dirname(path);
  if (type === "extension" && /^(?:index)\.(?:ts|js|mjs|cjs)$/u.test(basename(path))) return dirname(path);
  return path;
}

function findConflicts(resources, owners, ignoredOwnerId) {
  return resources
    .map((resource) => ({ ...resource, owner: owners.get(resource.semanticId) }))
    .filter((resource) => resource.owner && resource.owner.id !== ignoredOwnerId);
}

function sameResolvedPackage(existing, incoming) {
  if (existing.dependency?.spec !== incoming.dependency?.spec) return false;
  if (existing.resolved !== incoming.resolved) return false;
  return JSON.stringify(existing.resources) === JSON.stringify(incoming.resources);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.kind === "package" ? candidate.id : `${candidate.semanticId}:${candidate.originalPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceKind(source) {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(?:https?|ssh|git):\/\//u.test(source)) return "git";
  return "local";
}

function normalizeGitSource(source) {
  const withoutPrefix = source.replace(/^git:/u, "");
  const withoutRef = withoutPrefix.replace(/@(?:[^/@]+)$/u, "");
  return normalizeRepository(withoutRef);
}

function dependencyGitUrl(remote) {
  if (remote.startsWith("git+")) return remote;
  const scp = /^git@([^:]+):(.+)$/u.exec(remote);
  if (scp) return `git+ssh://git@${scp[1]}/${scp[2]}`;
  if (remote.startsWith("ssh://")) return `git+${remote}`;
  return `git+${remote}`;
}

function safeName(value) {
  return value.replace(/^@/u, "").replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

async function skillName(path) {
  const skillFile = basename(path) === "SKILL.md" ? path : join(path, "SKILL.md");
  const content = await readFile(skillFile, "utf8");
  const name = /^name:\s*(.+)$/mu.exec(content)?.[1]?.trim();
  if (!name) throw new Error(`Skill is missing frontmatter name: ${skillFile}`);
  return name;
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function safeRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function toPosix(path) {
  return path.split(sep).join("/");
}
