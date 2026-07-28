#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = resolveAgentDir();
const settings = await readJson(join(agentDir, "settings.json"));
const bundleManifestPath = join(repoRoot, "package.json");
const bundleManifest = await readJson(bundleManifestPath);
const resourceTypes = ["extensions", "skills", "prompts", "themes"];
const dependencies = {};
const resources = Object.fromEntries(resourceTypes.map((type) => [type, []]));
const skippedSources = [];

for (const entry of settings.packages ?? []) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string") continue;
  if (!source.startsWith("npm:")) {
    skippedSources.push(source);
    continue;
  }

  const packageName = npmPackageName(source.slice(4));
  const manifestPath = join(agentDir, "npm", "node_modules", packageName, "package.json");
  const manifest = await readJson(manifestPath);
  dependencies[packageName] = manifest.version;

  for (const type of resourceTypes) {
    const declared = manifest.pi?.[type];
    if (Array.isArray(declared)) {
      resources[type].push(...declared.map((path) => dependencyResource(packageName, path)));
      continue;
    }

    const conventionalPath = join(agentDir, "npm", "node_modules", packageName, type);
    if (await exists(conventionalPath)) {
      resources[type].push(`./node_modules/${packageName}/${type}`);
    }
  }
}

await mirrorUserResources("skills");
for (const type of ["extensions", "prompts", "themes"]) {
  const source = join(agentDir, type);
  if (await exists(source)) {
    throw new Error(
      `Found user-level ${type} at ${source}. Review and add it manually; the sync script only copies skills.`,
    );
  }
}

bundleManifest.dependencies = Object.fromEntries(
  Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
);
bundleManifest.pi = Object.fromEntries(
  resourceTypes
    .map((type) => [type, [...new Set(resources[type])]])
    .filter(([, paths]) => paths.length > 0),
);

await writeFile(bundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`);

console.log(`Synchronized ${Object.keys(dependencies).length} npm packages from ${agentDir}`);
console.log(`Synchronized ${resources.skills.includes("./skills") ? "user skills" : "no user skills"}`);
if (skippedSources.length > 0) {
  console.warn(`Skipped non-npm package sources: ${skippedSources.join(", ")}`);
}

async function mirrorUserResources(type) {
  const source = join(agentDir, type);
  const destination = join(repoRoot, type);
  await rm(destination, { recursive: true, force: true });
  if (!(await exists(source))) return;
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !path.endsWith("/.DS_Store") && !path.endsWith("\\.DS_Store"),
  });
  resources[type].unshift(`./${type}`);
}

function resolveAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function npmPackageName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionSeparator = spec.lastIndexOf("@");
    return versionSeparator > slash ? spec.slice(0, versionSeparator) : spec;
  }
  const versionSeparator = spec.lastIndexOf("@");
  return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
}

function dependencyResource(packageName, path) {
  if (typeof path !== "string") {
    throw new TypeError(`Unsupported resource entry in ${packageName}: ${JSON.stringify(path)}`);
  }
  const modifier = /^[!+-]/u.test(path) ? path[0] : "";
  const relativePath = (modifier ? path.slice(1) : path).replace(/^\.\//u, "");
  return `${modifier}./node_modules/${packageName}/${relativePath}`;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
