import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoverCandidates } from "../../extensions/package-manager/inventory.mjs";
import { refreshResourceHashes } from "../../extensions/package-manager/bundle.mjs";
import { baseBundle, run, temporaryDirectory, writeJson } from "./helpers.mjs";

test("discovery finds direct npm packages and top-level skills but excludes managed bundle", async (t) => {
  const root = await temporaryDirectory("pi-root-");
  const agentDir = await temporaryDirectory("pi-agent-");
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(agentDir, { recursive: true, force: true })]));
  const npmRoot = join(agentDir, "npm/node_modules/example-ext");
  const skillRoot = join(agentDir, "skills/new-skill");
  await mkdir(npmRoot, { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeJson(join(npmRoot, "package.json"), { name: "example-ext", version: "2.0.0", license: "MIT" });
  await writeFile(join(npmRoot, "index.ts"), "export default () => {};\n");
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: new-skill\ndescription: New skill\n---\n");
  await mkdir(join(root, "extensions/package-manager"), { recursive: true });
  await writeFile(join(root, "extensions/package-manager/index.ts"), "export default () => {};\n");
  const bundle = baseBundle();
  await refreshResourceHashes(root, bundle);
  const packageManager = {
    listConfiguredPackages: () => [
      { source: "git:github.com/test/pi", scope: "user", filtered: false, installedPath: root },
      { source: "npm:example-ext", scope: "user", filtered: false, installedPath: npmRoot },
    ],
    resolveExtensionSources: async ([source]) => source === "npm:example-ext" ? ({
      extensions: [
        { path: join(npmRoot, "index.ts"), enabled: true, metadata: { source: "npm:example-ext", scope: "user", origin: "package", baseDir: npmRoot } },
      ],
      skills: [], prompts: [], themes: [],
    }) : ({ extensions: [], skills: [], prompts: [], themes: [] }),
    resolve: async () => ({
      extensions: [
        { path: join(root, "extensions/package-manager/index.ts"), enabled: true, metadata: { source: "git:github.com/test/pi", scope: "user", origin: "package", baseDir: root } },
        { path: join(npmRoot, "index.ts"), enabled: true, metadata: { source: "npm:example-ext", scope: "user", origin: "package", baseDir: npmRoot } },
      ],
      skills: [
        { path: join(skillRoot, "SKILL.md"), enabled: true, metadata: { source: skillRoot, scope: "user", origin: "top-level", baseDir: skillRoot } },
      ],
      prompts: [],
      themes: [],
    }),
  };
  const candidates = await discoverCandidates({ root, agentDir, bundle, packageManager, run });
  assert.deepEqual(candidates.map((candidate) => candidate.id).sort(), ["npm:example-ext", "skill:new-skill"]);
  const npm = candidates.find((candidate) => candidate.id === "npm:example-ext");
  assert.equal(npm.record.dependency.spec, "2.0.0");
  assert.equal(npm.record.scope, "user");
  assert.deepEqual(npm.record.resources.extensions, ["index.ts"]);
});

test("discovery supports standalone extensions with sibling imports, prompts, and named themes", async (t) => {
  const root = await temporaryDirectory("pi-root-");
  const resources = await temporaryDirectory("pi-resources-");
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(resources, { recursive: true, force: true })]));
  await mkdir(join(root, "extensions/package-manager"), { recursive: true });
  await writeFile(join(root, "extensions/package-manager/index.ts"), "export default () => {};\n");
  const extension = join(resources, "sample.ts");
  const helper = join(resources, "helper.js");
  const prompt = join(resources, "review.md");
  const theme = join(resources, "ocean.json");
  await writeFile(extension, "import './helper.js';\nexport default () => {};\n");
  await writeFile(helper, "export const value = 1;\n");
  await writeFile(prompt, "Review this.\n");
  await writeJson(theme, { name: "ocean", colors: {} });
  const bundle = baseBundle();
  await refreshResourceHashes(root, bundle);
  const metadata = { source: resources, scope: "user", origin: "top-level", baseDir: resources };
  const packageManager = {
    listConfiguredPackages: () => [],
    resolveExtensionSources: async () => ({ extensions: [], skills: [], prompts: [], themes: [] }),
    resolve: async () => ({
      extensions: [{ path: extension, enabled: true, metadata }],
      skills: [],
      prompts: [{ path: prompt, enabled: true, metadata }],
      themes: [{ path: theme, enabled: true, metadata }],
    }),
  };
  const candidates = await discoverCandidates({ root, agentDir: resources, bundle, packageManager, run });
  assert.deepEqual(candidates.map((candidate) => candidate.id).sort(), ["extension:sample", "prompt:review", "theme:ocean"]);
  assert.deepEqual(candidates.find((candidate) => candidate.id === "extension:sample").supportFiles.map((path) => path.split("/").at(-1)), ["helper.js"]);
});
