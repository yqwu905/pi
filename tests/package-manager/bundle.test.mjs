import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertGeneratedManifestCurrent,
  generatePackageManifest,
  hashPath,
  refreshResourceHashes,
  saveBundle,
  validateBundle,
} from "../../extensions/package-manager/bundle.mjs";
import { baseBundle, temporaryDirectory, writeJson } from "./helpers.mjs";

test("bundle generates deterministic dependency and resource metadata", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "extensions/package-manager"), { recursive: true });
  await mkdir(join(root, "skills/demo"), { recursive: true });
  await writeFile(join(root, "extensions/package-manager/index.ts"), "export default () => {};\n");
  await writeFile(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n");
  const bundle = baseBundle();
  bundle.packages.push({
    id: "npm:demo-extension",
    installSource: "npm:demo-extension",
    source: { type: "npm", name: "demo-extension", version: "1.2.3" },
    dependency: { name: "demo-extension", spec: "1.2.3" },
    resolved: "1.2.3",
    resources: { extensions: ["index.ts"], skills: [], prompts: [], themes: [] },
    license: "MIT",
  });
  bundle.resources.push({
    id: "skill:demo",
    type: "skill",
    name: "demo",
    path: "skills/demo",
    source: { type: "local-vendor" },
  });
  await refreshResourceHashes(root, bundle);
  validateBundle(bundle, root);
  const generated = await generatePackageManifest(root, bundle, {
    name: "@test/pi",
    version: "1.0.0",
    dependencies: {},
    pi: {},
  });
  assert.deepEqual(generated.dependencies, { "demo-extension": "1.2.3" });
  assert.deepEqual(generated.pi.extensions, [
    "./node_modules/demo-extension/index.ts",
    "./extensions/package-manager/index.ts",
  ]);
  assert.deepEqual(generated.pi.skills, ["./skills/demo"]);
  await saveBundle(root, bundle);
  await writeJson(join(root, "package.json"), generated);
  await assertGeneratedManifestCurrent(root, bundle);
  assert.equal(bundle.resources[1].sha256, await hashPath(join(root, "skills/demo")));
});

test("bundle rejects mutable dependencies and missing manager protection", () => {
  const mutable = baseBundle();
  mutable.packages.push({
    id: "npm:bad",
    source: { type: "npm", name: "bad", version: "1.0.0" },
    dependency: { name: "bad", spec: "^1.0.0" },
    resources: { extensions: [], skills: [], prompts: [], themes: [] },
  });
  assert.throws(() => validateBundle(mutable), /exact resolved version/u);
  const missing = baseBundle();
  missing.resources = [];
  assert.throws(() => validateBundle(missing), /Protected extension:package-manager/u);
  const destructive = baseBundle();
  destructive.resources.push({
    id: "skill:danger",
    type: "skill",
    name: "danger",
    path: ".",
    source: { type: "local-vendor" },
  });
  assert.throws(() => validateBundle(destructive), /package root is not a valid resource path/u);
  const destructivePackage = baseBundle();
  destructivePackage.packages.push({
    id: "local:danger",
    source: { type: "local" },
    vendorRoot: ".",
    resources: { extensions: [], skills: [], prompts: [], themes: [] },
  });
  assert.throws(() => validateBundle(destructivePackage), /package root is not a valid resource path/u);
});
