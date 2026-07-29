import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fastForwardPull, inspectGit, requireWritableMain, sameRepository } from "../../extensions/package-manager/git.mjs";
import { readPendingSnapshot, savePendingSnapshot, withRepositoryTransaction } from "../../extensions/package-manager/transaction.mjs";
import { run, temporaryDirectory } from "./helpers.mjs";

test("Git shorthand and HTTPS identify the same repository", () => {
  assert.equal(sameRepository("git:github.com/yqwu905/pi", "https://github.com/yqwu905/pi.git"), true);
});

test("Git guard accepts clean synchronized main and rejects dirty or detached checkout", async (t) => {
  const fixture = await createGitFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const expected = fixture.bare;
  await requireWritableMain(fixture.clone, run, expected, { fetch: true, requireClean: true });
  await writeFile(join(fixture.clone, "dirty.txt"), "dirty\n");
  await assert.rejects(
    requireWritableMain(fixture.clone, run, expected, { fetch: false, requireClean: true }),
    /pending changes/u,
  );
  await rm(join(fixture.clone, "dirty.txt"));
  await run("git", ["checkout", "--detach"], { cwd: fixture.clone });
  await assert.rejects(
    requireWritableMain(fixture.clone, run, expected, { fetch: false, requireClean: true }),
    /unpinned rolling install/u,
  );
});

test("pull fast-forwards a clean behind checkout", async (t) => {
  const fixture = await createGitFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.seed, "new.txt"), "remote update\n");
  await run("git", ["add", "."], { cwd: fixture.seed });
  await run("git", ["commit", "-m", "remote update"], { cwd: fixture.seed });
  await run("git", ["push", "origin", "main"], { cwd: fixture.seed });
  await fastForwardPull(fixture.clone, run, fixture.bare);
  assert.equal(await readFile(join(fixture.clone, "new.txt"), "utf8"), "remote update\n");
});

test("repository transaction restores managed files after failure", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "skills/original"), { recursive: true });
  await writeFile(join(root, "bundle.json"), "before\n");
  await writeFile(join(root, "skills/original/SKILL.md"), "before skill\n");
  await assert.rejects(
    withRepositoryTransaction(root, "test", async () => {
      await writeFile(join(root, "bundle.json"), "after\n");
      await rm(join(root, "skills"), { recursive: true, force: true });
      throw new Error("boom");
    }),
    /boom/u,
  );
  assert.equal(await readFile(join(root, "bundle.json"), "utf8"), "before\n");
  assert.equal(await readFile(join(root, "skills/original/SKILL.md"), "utf8"), "before skill\n");
});

test("pending snapshots live outside the managed checkout", async (t) => {
  const root = await temporaryDirectory("pi-checkout-");
  const stateRoot = await temporaryDirectory("pi-state-");
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]));
  await writeFile(join(root, "bundle.json"), "pending\n");
  await savePendingSnapshot(root, stateRoot);
  await rm(join(root, "bundle.json"));
  const pending = await readPendingSnapshot(stateRoot);
  assert.equal(await readFile(join(pending.pendingRoot, "bundle.json"), "utf8"), "pending\n");
});

async function createGitFixture() {
  const root = await temporaryDirectory("pi-git-");
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  await run("git", ["init", "--bare", bare]);
  await run("git", ["clone", bare, seed]);
  await run("git", ["checkout", "-b", "main"], { cwd: seed });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: seed });
  await run("git", ["config", "user.name", "Test"], { cwd: seed });
  await writeFile(join(seed, "README.md"), "fixture\n");
  await run("git", ["add", "."], { cwd: seed });
  await run("git", ["commit", "-m", "init"], { cwd: seed });
  await run("git", ["push", "-u", "origin", "main"], { cwd: seed });
  await run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });
  await run("git", ["clone", bare, clone]);
  const state = await inspectGit(clone, run, { fetch: false });
  assert.equal(state.branch, "main");
  return { root, bare, seed, clone };
}
