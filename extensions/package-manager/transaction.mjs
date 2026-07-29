import { cp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MANAGED_PATHS = [
  "bundle.json",
  "package.json",
  "package-lock.json",
  "vendor",
  "skills",
  "prompts",
  "themes",
];

export async function withRepositoryTransaction(root, action, operation, options = {}) {
  const stateRoot = options.stateRoot ?? join(root, ".pi", "package-manager");
  const lockPath = join(stateRoot, "lock");
  const journalPath = join(stateRoot, "journal.json");
  const backupRoot = join(stateRoot, `backup-${Date.now()}`);
  await mkdir(stateRoot, { recursive: true });

  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another /package operation is already running");
    throw error;
  }

  let snapshotComplete = false;
  try {
    await snapshot(root, backupRoot);
    snapshotComplete = true;
    await writeFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, action, startedAt: new Date().toISOString(), backupRoot }, null, 2)}\n`,
    );
    const result = await operation();
    await rm(journalPath, { force: true });
    await rm(backupRoot, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (!snapshotComplete) {
      await rm(backupRoot, { recursive: true, force: true });
      throw error;
    }
    try {
      await restore(root, backupRoot);
      await rm(journalPath, { force: true });
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Package operation failed and rollback was incomplete; run /package doctor");
    }
    throw error;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function readRecoveryJournal(root, stateRoot = join(root, ".pi", "package-manager")) {
  try {
    return JSON.parse(await readFile(join(stateRoot, "journal.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function savePendingSnapshot(root, stateRoot) {
  const pendingRoot = join(stateRoot, "pending");
  await rm(pendingRoot, { recursive: true, force: true });
  await snapshot(root, pendingRoot);
  await writeFile(
    join(stateRoot, "pending.json"),
    `${JSON.stringify({ savedAt: new Date().toISOString(), pendingRoot }, null, 2)}\n`,
  );
}

export async function clearPendingSnapshot(stateRoot) {
  await rm(join(stateRoot, "pending"), { recursive: true, force: true });
  await rm(join(stateRoot, "pending.json"), { force: true });
}

export async function readPendingSnapshot(stateRoot) {
  try {
    return JSON.parse(await readFile(join(stateRoot, "pending.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function snapshot(root, backupRoot) {
  await mkdir(backupRoot, { recursive: true });
  for (const path of MANAGED_PATHS) {
    const source = join(root, path);
    if (!(await exists(source))) continue;
    const destination = join(backupRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
}

async function restore(root, backupRoot) {
  for (const path of MANAGED_PATHS) await rm(join(root, path), { recursive: true, force: true });
  if (!(await exists(backupRoot))) return;
  for (const path of MANAGED_PATHS) {
    const source = join(backupRoot, path);
    if (!(await exists(source))) continue;
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
  await rm(backupRoot, { recursive: true, force: true });
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
