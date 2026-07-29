import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];
export const TYPE_TO_PLURAL = {
  extension: "extensions",
  skill: "skills",
  prompt: "prompts",
  theme: "themes",
};
export const PLURAL_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_TO_PLURAL).map(([type, plural]) => [plural, type]),
);
export const MANAGER_RESOURCE_ID = "extension:package-manager";

export async function loadBundle(root) {
  const path = join(root, "bundle.json");
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${formatError(error)}`);
  }
  validateBundle(value, root);
  return value;
}

export function validateBundle(bundle, root = undefined) {
  if (!isRecord(bundle) || bundle.schemaVersion !== 1) {
    throw new Error("bundle.json must be an object with schemaVersion 1");
  }
  if (!isRecord(bundle.package)) throw new Error("bundle.package is required");
  for (const key of ["name", "repository", "branch", "remote", "installSource"]) {
    if (typeof bundle.package[key] !== "string" || bundle.package[key].length === 0) {
      throw new Error(`bundle.package.${key} is required`);
    }
  }
  if (!Array.isArray(bundle.packages) || !Array.isArray(bundle.resources)) {
    throw new Error("bundle.packages and bundle.resources must be arrays");
  }

  const ids = new Set();
  const dependencyNames = new Set();
  const ownedRoots = new Set();
  for (const pkg of bundle.packages) {
    if (!isRecord(pkg) || typeof pkg.id !== "string" || !isRecord(pkg.source)) {
      throw new Error("Every bundle package requires id and source");
    }
    assertUnique(ids, pkg.id);
    if (!isRecord(pkg.resources)) throw new Error(`${pkg.id}: resources are required`);
    for (const type of RESOURCE_TYPES) {
      const paths = pkg.resources[type] ?? [];
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
        throw new Error(`${pkg.id}: invalid ${type}`);
      }
      for (const path of paths) assertSafeRelativePath(path, `${pkg.id}.${type}`);
    }
    if (pkg.identities !== undefined) {
      if (!Array.isArray(pkg.identities) || pkg.identities.some((identity) => !isRecord(identity) || !Object.hasOwn(TYPE_TO_PLURAL, identity.type) || typeof identity.name !== "string")) {
        throw new Error(`${pkg.id}: invalid identities`);
      }
    }
    if (pkg.dependency !== undefined) {
      if (!isRecord(pkg.dependency) || typeof pkg.dependency.name !== "string" || typeof pkg.dependency.spec !== "string") {
        throw new Error(`${pkg.id}: invalid dependency`);
      }
      assertImmutableDependency(pkg);
      assertUnique(dependencyNames, pkg.dependency.name, "dependency name");
    } else if (typeof pkg.vendorRoot !== "string") {
      throw new Error(`${pkg.id}: dependency or vendorRoot is required`);
    } else {
      assertSafeRelativePath(pkg.vendorRoot, `${pkg.id}.vendorRoot`);
      if (!toPosix(pkg.vendorRoot).startsWith("vendor/packages/")) {
        throw new Error(`${pkg.id}: vendorRoot must be under vendor/packages/`);
      }
      assertUnique(ownedRoots, toPosix(pkg.vendorRoot), "owned path");
    }
  }

  for (const resource of bundle.resources) {
    if (!isRecord(resource) || typeof resource.id !== "string") {
      throw new Error("Every standalone resource requires id");
    }
    assertUnique(ids, resource.id);
    if (!Object.hasOwn(TYPE_TO_PLURAL, resource.type)) {
      throw new Error(`${resource.id}: invalid resource type`);
    }
    if (typeof resource.name !== "string" || typeof resource.path !== "string") {
      throw new Error(`${resource.id}: name and path are required`);
    }
    assertSafeRelativePath(resource.path, `${resource.id}.path`);
    if (resource.contentRoot !== undefined) {
      if (typeof resource.contentRoot !== "string") throw new Error(`${resource.id}: invalid contentRoot`);
      assertSafeRelativePath(resource.contentRoot, `${resource.id}.contentRoot`);
    }
    assertStandaloneResourceNamespace(resource);
    if (resource.id !== MANAGER_RESOURCE_ID) assertUnique(ownedRoots, toPosix(resource.contentRoot ?? resource.path), "owned path");
  }

  const manager = bundle.resources.find((resource) => resource.id === MANAGER_RESOURCE_ID);
  if (!manager || manager.type !== "extension" || manager.protected !== true) {
    throw new Error(`Protected ${MANAGER_RESOURCE_ID} resource is required`);
  }
  if (root) {
    for (const resource of bundle.resources) {
      const absolute = resolve(root, resource.path);
      if (!isInside(root, absolute)) throw new Error(`${resource.id}: path escapes package root`);
    }
  }
  return bundle;
}

export async function saveBundle(root, bundle) {
  validateBundle(bundle, root);
  await atomicWriteJson(join(root, "bundle.json"), bundle);
}

export async function generatePackageManifest(root, bundle, currentManifest = undefined) {
  validateBundle(bundle, root);
  const manifest = currentManifest ?? JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dependencies = {};
  const pi = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, []]));

  for (const pkg of [...bundle.packages].sort((a, b) => a.id.localeCompare(b.id))) {
    if (pkg.dependency) dependencies[pkg.dependency.name] = pkg.dependency.spec;
    const prefix = pkg.dependency ? `./node_modules/${pkg.dependency.name}` : `./${pkg.vendorRoot}`;
    for (const type of RESOURCE_TYPES) {
      for (const path of pkg.resources[type] ?? []) {
        pi[type].push(joinManifestPath(prefix, path));
      }
    }
  }

  for (const resource of bundle.resources) {
    pi[TYPE_TO_PLURAL[resource.type]].push(`./${toPosix(resource.path)}`);
  }

  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
  manifest.pi = Object.fromEntries(
    RESOURCE_TYPES.map((type) => [type, [...new Set(pi[type])]]).filter(([, paths]) => paths.length > 0),
  );
  return manifest;
}

export async function writeGeneratedPackageManifest(root, bundle) {
  const manifest = await generatePackageManifest(root, bundle);
  await atomicWriteJson(join(root, "package.json"), manifest);
  return manifest;
}

export async function assertGeneratedManifestCurrent(root, bundle) {
  const actual = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = await generatePackageManifest(root, bundle, structuredClone(actual));
  if (JSON.stringify(actual.dependencies ?? {}) !== JSON.stringify(expected.dependencies ?? {})) {
    throw new Error("package.json dependencies drift from bundle.json");
  }
  if (JSON.stringify(actual.pi ?? {}) !== JSON.stringify(expected.pi ?? {})) {
    throw new Error("package.json pi resources drift from bundle.json");
  }
}

export function resourceOwners(bundle) {
  const owners = new Map();
  for (const pkg of bundle.packages) {
    if (Array.isArray(pkg.identities)) {
      for (const identity of pkg.identities) {
        owners.set(`${identity.type}:${identity.name}`, { kind: "package", id: pkg.id });
      }
      continue;
    }
    for (const [plural, paths] of Object.entries(pkg.resources)) {
      const type = PLURAL_TO_TYPE[plural];
      if (!type) continue;
      for (const path of paths) {
        const inferred = semanticName(type, path);
        const name = inferred === "." ? (pkg.source.name?.split("/").at(-1) ?? inferred) : inferred;
        owners.set(`${type}:${name}`, { kind: "package", id: pkg.id });
      }
    }
  }
  for (const resource of bundle.resources) {
    owners.set(`${resource.type}:${resource.name}`, { kind: "resource", id: resource.id });
  }
  return owners;
}

export function semanticName(type, path) {
  const normalized = toPosix(path).replace(/\/$/u, "");
  if (type === "skill") {
    return basename(normalized) === "SKILL.md" ? basename(dirname(normalized)) : basename(normalized);
  }
  const name = basename(normalized).replace(/\.(?:ts|js|mjs|cjs|md|json)$/u, "");
  return name === "index" ? basename(dirname(normalized)) : name;
}

export function suggestVersion(currentVersion, changeKind) {
  const parsed = parseSemver(currentVersion);
  if (changeKind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export async function hashPath(path) {
  const info = await stat(path);
  const hash = createHash("sha256");
  if (info.isFile()) {
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (!info.isDirectory()) throw new Error(`Unsupported resource path: ${path}`);
  for (const file of await listFiles(path)) {
    hash.update(toPosix(relative(path, file)));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function refreshResourceHashes(root, bundle) {
  for (const resource of bundle.resources) {
    resource.sha256 = await hashPath(resolve(root, resource.contentRoot ?? resource.path));
  }
  return bundle;
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

function assertImmutableDependency(pkg) {
  if (pkg.source.type === "npm" && pkg.dependency.spec !== pkg.source.version) {
    throw new Error(`${pkg.id}: npm dependency must use its exact resolved version`);
  }
  if (pkg.source.type === "git" && !/#[0-9a-f]{7,40}$/u.test(pkg.dependency.spec)) {
    throw new Error(`${pkg.id}: Git dependency must be pinned to a commit`);
  }
}

function assertUnique(ids, id, label = "bundle id") {
  if (ids.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
  ids.add(id);
}

function assertSafeRelativePath(path, label) {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`${label}: invalid path`);
  }
  const normalized = toPosix(path).replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized === "." || normalized.length === 0) throw new Error(`${label}: package root is not a valid resource path`);
  if (normalized.split("/").includes("..")) throw new Error(`${label}: path traversal is not allowed`);
}

function assertStandaloneResourceNamespace(resource) {
  const path = toPosix(resource.path).replace(/^\.\//u, "");
  const contentRoot = toPosix(resource.contentRoot ?? resource.path).replace(/^\.\//u, "");
  if (resource.id === MANAGER_RESOURCE_ID) {
    if (path !== "extensions/package-manager/index.ts" || contentRoot !== "extensions/package-manager") {
      throw new Error(`${MANAGER_RESOURCE_ID}: protected paths cannot be changed`);
    }
    return;
  }
  const allowed = ["vendor/", "skills/", "prompts/", "themes/"];
  if (!allowed.some((prefix) => path.startsWith(prefix)) || !allowed.some((prefix) => contentRoot.startsWith(prefix))) {
    throw new Error(`${resource.id}: standalone resources must be under vendor/, skills/, prompts/, or themes/`);
  }
}

function joinManifestPath(prefix, path) {
  return `${prefix.replace(/\/$/u, "")}/${toPosix(path).replace(/^\.\//u, "")}`;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
