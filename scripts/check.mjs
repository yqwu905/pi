#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

const requiredSkills = ["grill-me", "grilling"];
for (const skill of requiredSkills) {
  const content = await readFile(join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
  if (!content.startsWith("---\n") || !content.includes(`\nname: ${skill}\n`) || !content.includes("\ndescription:")) {
    throw new Error(`Invalid skill frontmatter: ${skill}`);
  }
}

console.log(
  `Validated ${Object.keys(manifest.dependencies ?? {}).length} dependencies, ${checkedResources} resources, and ${requiredSkills.length} skills.`,
);
