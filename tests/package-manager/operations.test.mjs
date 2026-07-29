import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { refreshResourceHashes, saveBundle, writeGeneratedPackageManifest } from "../../extensions/package-manager/bundle.mjs";
import { addCandidates, findSensitiveManagedFiles, findUnmanagedChanges, publishPackage, removeUnits } from "../../extensions/package-manager/operations.mjs";
import { baseBundle, run as realRun, temporaryDirectory, writeJson } from "./helpers.mjs";

test("add and remove standalone resources preserve protected manager", async (t) => {
  const fixture = await createManagedFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceSkill = join(fixture.root, "../source-skill");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(join(sourceSkill, "SKILL.md"), "---\nname: imported\ndescription: Imported\n---\n");
  const candidate = {
    kind: "resource",
    id: "skill:imported",
    semanticId: "skill:imported",
    type: "skill",
    name: "imported",
    originalPath: join(sourceSkill, "SKILL.md"),
    copyRoot: sourceSkill,
    entryRelative: "SKILL.md",
    metadata: { source: sourceSkill, scope: "user", origin: "top-level" },
  };
  const run = fakeNpmRun;
  const added = await addCandidates({
    root: fixture.clone,
    bundle: fixture.bundle,
    plans: [{ candidate, replaceOwnerIds: [] }],
    run,
  });
  assert(added.resources.some((resource) => resource.id === "skill:imported"));
  assert(added.resources.some((resource) => resource.id === "extension:package-manager" && resource.protected));
  await realRun("git", ["add", "."], { cwd: fixture.clone });
  await realRun("git", ["commit", "-m", "add"], { cwd: fixture.clone });
  await realRun("git", ["push", "origin", "main"], { cwd: fixture.clone });
  const removed = await removeUnits({
    root: fixture.clone,
    bundle: added,
    unitIds: ["skill:imported"],
    run,
  });
  assert(!removed.bundle.resources.some((resource) => resource.id === "skill:imported"));
  await realRun("git", ["add", "."], { cwd: fixture.clone });
  await realRun("git", ["commit", "-m", "remove"], { cwd: fixture.clone });
  await realRun("git", ["push", "origin", "main"], { cwd: fixture.clone });
  await assert.rejects(
    removeUnits({ root: fixture.clone, bundle: removed.bundle, unitIds: ["extension:package-manager"], run }),
    /protected/u,
  );

  async function fakeNpmRun(command, args, options = {}) {
    if (command === "npm") return { stdout: "", stderr: "", code: 0, killed: false };
    return realRun(command, args, options);
  }
});

test("publish allowlist identifies unrelated tracked and untracked changes", async () => {
  const fakeRun = async () => ok(" M bundle.json\n?? vendor/skills/new/SKILL.md\n?? secrets.txt\n M README.md\n");
  assert.deepEqual(await findUnmanagedChanges("/tmp/example", fakeRun), ["secrets.txt", "README.md"]);
});

test("sensitive vendored files are blocked from publication", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "vendor/skills/leak"), { recursive: true });
  await writeFile(join(root, "vendor/skills/leak/.env"), "TOKEN=secret\n");
  const fakeRun = async () => ok("?? vendor/skills/leak/.env\n");
  assert.deepEqual(await findSensitiveManagedFiles(root, fakeRun), ["vendor/skills/leak/.env"]);
});

test("publish uses main, annotated tag, GitHub release, and increasing semver", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "extensions/package-manager"), { recursive: true });
  await writeFile(join(root, "extensions/package-manager/index.ts"), "export default () => {};\n");
  await writeJson(join(root, "package.json"), { name: "@test/pi", version: "1.0.0", scripts: { check: "true" }, dependencies: {}, pi: {} });
  await writeJson(join(root, "package-lock.json"), { name: "@test/pi", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "@test/pi", version: "1.0.0" } } });
  const bundle = baseBundle();
  await refreshResourceHashes(root, bundle);
  await saveBundle(root, bundle);
  await writeGeneratedPackageManifest(root, bundle);
  const calls = [];
  const fakeRun = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "branch") return ok("main\n");
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return ok("abc123\n");
    if (command === "git" && args[0] === "rev-parse" && args[1] === "origin/main") return ok("abc123\n");
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") return fail();
    if (command === "git" && args[0] === "remote") return ok("https://github.com/test/pi.git\n");
    if (command === "git" && args[0] === "status") return ok(" M bundle.json\n");
    if (command === "git" && args[0] === "rev-list") return ok("0\t0\n");
    if (command === "git" && args[0] === "ls-remote") return fail();
    if (command === "gh" && args[0] === "release" && args[1] === "view") return fail();
    return ok();
  };
  const result = await publishPackage({ root, bundle, version: "1.1.0", run: fakeRun });
  assert.equal(result.tag, "v1.1.0");
  const atomicPush = calls.findIndex((call) => call.join(" ") === "git push --atomic origin main v1.1.0");
  const release = calls.findIndex((call) => call[0] === "gh" && call[1] === "release" && call[2] === "create");
  assert(atomicPush >= 0 && release > atomicPush);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "1.1.0");
});

async function createManagedFixture() {
  const root = await temporaryDirectory("pi-ops-");
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  await realRun("git", ["init", "--bare", bare]);
  await realRun("git", ["clone", bare, seed]);
  await realRun("git", ["checkout", "-b", "main"], { cwd: seed });
  await realRun("git", ["config", "user.email", "test@example.com"], { cwd: seed });
  await realRun("git", ["config", "user.name", "Test"], { cwd: seed });
  await mkdir(join(seed, "extensions/package-manager"), { recursive: true });
  await writeFile(join(seed, "extensions/package-manager/index.ts"), "export default () => {};\n");
  await writeJson(join(seed, "package.json"), { name: "@test/pi", version: "1.0.0", scripts: { check: "true" }, dependencies: {}, pi: {} });
  const bundle = baseBundle();
  bundle.package.repository = bare;
  await refreshResourceHashes(seed, bundle);
  await saveBundle(seed, bundle);
  await writeGeneratedPackageManifest(seed, bundle);
  await realRun("git", ["add", "."], { cwd: seed });
  await realRun("git", ["commit", "-m", "init"], { cwd: seed });
  await realRun("git", ["push", "-u", "origin", "main"], { cwd: seed });
  await realRun("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });
  await realRun("git", ["clone", bare, clone]);
  return { root, clone, bundle: JSON.parse(await readFile(join(clone, "bundle.json"), "utf8")) };
}

function ok(stdout = "") {
  return { stdout, stderr: "", code: 0, killed: false };
}
function fail(stderr = "not found") {
  return { stdout: "", stderr, code: 1, killed: false };
}
