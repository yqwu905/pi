#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
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

const skillFiles = await findSkillFiles(join(repoRoot, "skills"));
if (skillFiles.length === 0) throw new Error("No skills found");
for (const path of skillFiles) {
  const content = await readFile(path, "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  if (!frontmatter || !/^name: .+/mu.test(frontmatter) || !/^description: .+/mu.test(frontmatter)) {
    throw new Error(`Invalid skill frontmatter: ${relative(repoRoot, path)}`);
  }
}

console.log(
  `Validated ${Object.keys(manifest.dependencies ?? {}).length} dependencies, ${checkedResources} resources, and ${skillFiles.length} skills.`,
);

async function findSkillFiles(directory) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await findSkillFiles(path)));
    if (entry.isFile() && entry.name === "SKILL.md") matches.push(path);
  }
  return matches;
}
