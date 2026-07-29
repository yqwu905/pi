#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertGeneratedManifestCurrent,
  hashPath,
  loadBundle,
  MANAGER_RESOURCE_ID,
} from "../extensions/package-manager/bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const bundle = await loadBundle(repoRoot);
await assertGeneratedManifestCurrent(repoRoot, bundle);
let checkedResources = 0;

for (const [name, expectedVersion] of Object.entries(manifest.dependencies ?? {})) {
  const dependencyManifest = JSON.parse(
    await readFile(join(repoRoot, "node_modules", name, "package.json"), "utf8"),
  );
  if (dependencyManifest.version !== expectedVersion) {
    throw new Error(`${name}: expected ${expectedVersion}, installed ${dependencyManifest.version}`);
  }
}

for (const paths of Object.values(manifest.pi ?? {})) {
  for (const configuredPath of paths) {
    const path = configuredPath.replace(/^[!+-]/u, "").replace(/^\.\//u, "");
    if (/[*?[\]{}]/u.test(path)) continue;
    await stat(join(repoRoot, path));
    checkedResources += 1;
  }
}

for (const resource of bundle.resources) {
  const actualHash = await hashPath(resolve(repoRoot, resource.contentRoot ?? resource.path));
  if (resource.sha256 !== actualHash) {
    throw new Error(`${resource.id}: sha256 drift; regenerate bundle.json`);
  }
}

const manager = bundle.resources.find((resource) => resource.id === MANAGER_RESOURCE_ID);
if (!manager?.protected) throw new Error("Protected package manager resource is missing");

const skillFiles = await findSkillFiles(join(repoRoot, "skills"));
for (const path of skillFiles) validateSkill(await readFile(path, "utf8"), relative(repoRoot, path));
const vendoredSkills = join(repoRoot, "vendor", "skills");
if (await exists(vendoredSkills)) {
  for (const path of await findSkillFiles(vendoredSkills)) {
    validateSkill(await readFile(path, "utf8"), relative(repoRoot, path));
  }
}

console.log(
  `Validated ${Object.keys(manifest.dependencies ?? {}).length} dependencies, ${checkedResources} configured resources, ${bundle.resources.length} standalone hashes, and ${skillFiles.length} built-in skills.`,
);

function validateSkill(content, label) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  if (!frontmatter || !/^name: .+/mu.test(frontmatter) || !/^description: .+/mu.test(frontmatter)) {
    throw new Error(`Invalid skill frontmatter: ${label}`);
  }
}

async function findSkillFiles(directory) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await findSkillFiles(path)));
    if (entry.isFile() && entry.name === "SKILL.md") matches.push(path);
  }
  return matches;
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
