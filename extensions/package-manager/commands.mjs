import { readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadBundle, MANAGER_RESOURCE_ID, resourceOwners } from "./bundle.mjs";
import { discoverCandidates, packageIdentity } from "./inventory.mjs";
import {
  addCandidates,
  doctorPackage,
  publishPackage,
  pullPackage,
  removeUnits,
  reviewPackage,
} from "./operations.mjs";
import { inspectGit } from "./git.mjs";
import { readPendingSnapshot } from "./transaction.mjs";

export const SUBCOMMANDS = ["status", "add", "remove", "review", "pull", "publish", "doctor"];

export function commandCompletions(prefix) {
  const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
  return items.length > 0 ? items : null;
}

export async function handlePackageCommand(args, ctx, runtime) {
  const requested = args.trim().split(/\s+/u)[0] || "";
  const subcommand = requested || (await chooseSubcommand(ctx));
  if (!subcommand) return;
  if (!SUBCOMMANDS.includes(subcommand)) throw new Error(`Unknown /package subcommand: ${subcommand}`);

  let bundle;
  try {
    bundle = await loadBundle(runtime.root);
  } catch (error) {
    if (subcommand === "doctor") {
      return notify(ctx, `✗ bundle schema — ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    throw error;
  }
  if (subcommand === "status") return statusCommand(ctx, runtime, bundle);
  if (subcommand === "doctor") return doctorCommand(ctx, runtime, bundle);
  requireInteractive(ctx, subcommand);
  if (subcommand === "add") return addCommand(ctx, runtime, bundle);
  if (subcommand === "remove") return removeCommand(ctx, runtime, bundle);
  if (subcommand === "review") return reviewCommand(ctx, runtime, bundle);
  if (subcommand === "pull") return pullCommand(ctx, runtime, bundle);
  if (subcommand === "publish") return publishCommand(ctx, runtime, bundle);
}

async function chooseSubcommand(ctx) {
  requireInteractive(ctx, "menu");
  const labels = [
    "status — inventory and Git state",
    "add — import installed resources",
    "remove — remove managed resources",
    "review — inspect pending changes",
    "pull — fast-forward from GitHub",
    "publish — validate and release",
    "doctor — diagnose package health",
  ];
  const selected = await ctx.ui.select("Pi package manager", labels);
  return selected?.split(" ", 1)[0];
}

async function statusCommand(ctx, runtime, bundle) {
  const git = await inspectGit(runtime.root, runtime.run, { fetch: false });
  const candidates = await discoverCandidates({
    root: runtime.root,
    agentDir: runtime.agentDir,
    bundle,
    packageManager: runtime.packageManager,
    run: runtime.run,
  });
  const manifest = JSON.parse(await readFile(join(runtime.root, "package.json"), "utf8"));
  const pendingBackup = await readPendingSnapshot(runtime.stateRoot);
  const managedPackageIds = new Set(bundle.packages.map((pkg) => pkg.id));
  const duplicatePackages = runtime.packageManager
    .listConfiguredPackages()
    .filter((entry) => managedPackageIds.has(packageIdentity(entry.source)));
  const lines = [
    `Package: ${manifest.name}@${manifest.version}`,
    `Checkout: ${runtime.root}`,
    `Managed install: ${runtime.managedInstall ? "yes" : "no (write commands disabled)"}`,
    `Git: ${git.detached ? "detached" : git.branch}; ${git.dirty ? "pending changes" : "clean"}; ahead ${git.ahead}, behind ${git.behind}`,
    `Managed: ${bundle.packages.length} packages, ${bundle.resources.length} standalone resources`,
    `Available to import/update: ${candidates.length}`,
    ...(pendingBackup ? [`External recovery backup: ${pendingBackup.pendingRoot} (${pendingBackup.savedAt})`] : []),
    ...(duplicatePackages.length > 0 ? [`Direct package duplicates: ${duplicatePackages.map((entry) => entry.source).join(", ")}`] : []),
  ];
  if (candidates.length > 0) lines.push(...candidates.slice(0, 20).map((candidate) => `  • ${candidate.label}`));
  notify(ctx, lines.join("\n"), git.diverged ? "warning" : "info");
}

async function addCommand(ctx, runtime, bundle) {
  await assertWritableRuntime(runtime);
  const candidates = await discoverCandidates({
    root: runtime.root,
    agentDir: runtime.agentDir,
    bundle,
    packageManager: runtime.packageManager,
    run: runtime.run,
  });
  if (candidates.length === 0) return notify(ctx, "No installed resources are missing from the package.", "info");

  const selected = await multiSelect(ctx, "Select installed resources to add", candidates, (candidate) => candidate.label);
  if (selected.length === 0) return;
  const plans = [];
  const reserved = new Set();
  for (const candidate of selected) {
    const plan = await resolveConflicts(ctx, candidate);
    if (!plan) continue;
    for (const semantic of candidate.kind === "package" ? candidate.semanticResources : [{ semanticId: candidate.semanticId }]) {
      const effective = plan.renameTo && candidate.kind === "resource" ? `${candidate.type}:${plan.renameTo}` : semantic.semanticId;
      if (reserved.has(effective)) throw new Error(`Selected resources conflict with each other: ${effective}`);
      reserved.add(effective);
    }
    plans.push(plan);
  }
  if (plans.length === 0) return notify(ctx, "Nothing selected after conflict resolution.", "info");

  const preview = plans.map(({ candidate, renameTo }) => `• ${candidate.label}${renameTo ? ` → ${renameTo}` : ""}`).join("\n");
  if (!(await ctx.ui.confirm("Apply package additions?", `${preview}\n\nChanges remain unpublished until /package publish.`))) return;
  await addCandidates({ root: runtime.root, bundle, plans, run: runtime.run, stateRoot: runtime.stateRoot });
  notify(ctx, `Added ${plans.length} unit(s). Run /package review, then /package publish.`, "info");
}

async function removeCommand(ctx, runtime, bundle) {
  await assertWritableRuntime(runtime);
  const units = [
    ...bundle.packages.map((value) => ({ id: value.id, kind: "package", value, label: `${value.id} (${countResources(value.resources)} resources)` })),
    ...bundle.resources
      .filter((value) => !value.protected && value.id !== MANAGER_RESOURCE_ID)
      .map((value) => ({ id: value.id, kind: "resource", value, label: `${value.id} — ${value.path}` })),
  ];
  if (units.length === 0) return notify(ctx, "No removable resources.", "info");
  const selected = await multiSelect(ctx, "Select package resources to remove", units, (unit) => unit.label);
  if (selected.length === 0) return;
  if (!(await ctx.ui.confirm("Remove from package?", selected.map((unit) => `• ${unit.label}`).join("\n")))) return;
  const result = await removeUnits({
    root: runtime.root,
    bundle,
    unitIds: selected.map((unit) => unit.id),
    run: runtime.run,
    stateRoot: runtime.stateRoot,
  });
  notify(ctx, `Removed ${result.removed.length} unit(s) from the package. Changes are not published yet.`, "info");

  for (const unit of selected) {
    if (!(await ctx.ui.confirm("Also uninstall locally?", `${unit.id}\nThis is separate from the package repository change.`))) continue;
    await uninstallCurrentMachine(ctx, runtime, unit);
  }
}

async function reviewCommand(ctx, runtime, bundle) {
  const review = await reviewPackage({ root: runtime.root, bundle, run: runtime.run });
  const text = [
    `Git: ${review.git.branch || "detached"}; ${review.git.dirty ? "pending" : "clean"}`,
    `Suggested release: ${review.suggestedVersion} (${review.suggestedChange})`,
    "",
    review.stat || "No diff",
    ...(review.unrelatedChanges.length > 0 ? ["", `UNMANAGED CHANGES (publish blocked): ${review.unrelatedChanges.join(", ")}`] : []),
    "",
    review.diff || "No pending package changes",
  ].join("\n");
  await ctx.ui.editor("Package review — close without editing", text);
}

async function pullCommand(ctx, runtime, bundle) {
  await assertWritableRuntime(runtime);
  if (!(await ctx.ui.confirm("Pull package updates?", "Requires a clean main checkout and performs a fast-forward-only pull."))) return;
  await pullPackage({ root: runtime.root, bundle, run: runtime.run });
  notify(ctx, "Package updated. Reloading Pi…", "info");
  await ctx.reload();
}

async function publishCommand(ctx, runtime, bundle) {
  await assertWritableRuntime(runtime);
  const review = await reviewPackage({ root: runtime.root, bundle, run: runtime.run });
  if (!review.git.dirty) return notify(ctx, "There are no changes to publish.", "info");
  await ctx.ui.editor(
    "Review before publishing — close without editing",
    [review.stat, "", review.diff].join("\n"),
  );
  const entered = await ctx.ui.input("Release version", review.suggestedVersion);
  if (!entered) return;
  const version = entered.trim().replace(/^v/u, "");
  if (!(await ctx.ui.confirm("Publish directly to main?", `Version v${version}\nThis commits, pushes main and a tag, then creates a GitHub Release.`))) return;

  const cleanup = await pendingImportedUnits(runtime.root, bundle, runtime.run);
  const result = await publishPackage({
    root: runtime.root,
    bundle,
    version,
    run: runtime.run,
    stateRoot: runtime.stateRoot,
  });
  notify(ctx, `Published ${result.tag}.`, "info");
  await cleanupNewDirectInstalls(ctx, runtime, cleanup);
  notify(ctx, "Publication complete. Reloading Pi…", "info");
  await ctx.reload();
}

async function doctorCommand(ctx, runtime, bundle) {
  const checks = await doctorPackage({
    root: runtime.root,
    bundle,
    run: runtime.run,
    managedInstall: runtime.managedInstall,
    stateRoot: runtime.stateRoot,
  });
  const lines = checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  notify(ctx, lines.join("\n"), checks.every((check) => check.ok) ? "info" : "warning");
}

async function resolveConflicts(ctx, candidate) {
  const plan = { candidate, replaceOwnerIds: [] };
  for (const conflict of candidate.conflicts ?? []) {
    const options = ["Keep bundled resource (skip incoming unit)", "Replace bundled owner"];
    if (candidate.kind === "resource" && candidate.type !== "extension") options.push("Import with a new name");
    const choice = await ctx.ui.select(
      `Conflict: ${conflict.semanticId}`,
      options,
    );
    if (!choice || choice.startsWith("Keep")) return undefined;
    if (choice.startsWith("Replace")) plan.replaceOwnerIds.push(conflict.owner.id);
    if (choice.startsWith("Import")) {
      const name = await ctx.ui.input("New resource name", `${candidate.name}-imported`);
      if (!name) return undefined;
      plan.renameTo = validateResourceName(name.trim());
    }
  }
  return plan;
}

async function multiSelect(ctx, title, items, label) {
  const selected = new Set();
  while (true) {
    const choices = [
      `Done (${selected.size} selected)`,
      ...items.map((item, index) => `${selected.has(index) ? "[x]" : "[ ]"} ${label(item)}`),
    ];
    const choice = await ctx.ui.select(title, choices);
    if (!choice || choice.startsWith("Done")) break;
    const index = choices.indexOf(choice) - 1;
    if (index < 0) continue;
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map((index) => items[index]);
}

async function uninstallCurrentMachine(ctx, runtime, unit) {
  if (unit.kind === "package") {
    const removed = await runtime.packageManager.removeAndPersist(unit.value.installSource, {
      local: unit.value.scope === "project",
    });
    notify(ctx, removed ? `Uninstalled ${unit.value.installSource}.` : `${unit.value.installSource} was not directly installed on this machine.`, "info");
    if (unit.value.source?.type === "local" && unit.value.source.originalPath) {
      await permanentlyDelete(ctx, unit.value.source.originalPath, unit.id);
    }
    return;
  }
  const originalPath = unit.value.source?.originalPath;
  if (!originalPath) return notify(ctx, "No separate local source path is recorded for this resource.", "info");
  await removeConfiguredResourcePath(runtime, unit);
  await permanentlyDelete(ctx, originalPath, unit.id);
}

async function removeConfiguredResourcePath(runtime, unit) {
  const source = unit.value.source;
  const candidates = new Set([source?.source, source?.originalPath].filter((value) => typeof value === "string"));
  if (candidates.size === 0) return;
  const manager = runtime.settingsManager;
  const project = source.scope === "project";
  const definitions = {
    extension: ["extensions", "getExtensionPaths", "setExtensionPaths", "setProjectExtensionPaths"],
    skill: ["skills", "getSkillPaths", "setSkillPaths", "setProjectSkillPaths"],
    prompt: ["prompts", "getPromptTemplatePaths", "setPromptTemplatePaths", "setProjectPromptTemplatePaths"],
    theme: ["themes", "getThemePaths", "setThemePaths", "setProjectThemePaths"],
  };
  const [field, getter, globalSetter, projectSetter] = definitions[unit.value.type];
  const current = project ? (manager.getProjectSettings()[field] ?? []) : manager[getter]();
  const filtered = current.filter((path) => !candidates.has(path));
  if (filtered.length === current.length) return;
  if (project) manager[projectSetter](filtered);
  else manager[globalSetter](filtered);
  await manager.flush();
}

async function permanentlyDelete(ctx, path, resourceId) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return notify(ctx, `Local source is already absent: ${path}`, "info");
    throw error;
  }
  if (!(await ctx.ui.confirm("Permanent deletion", `${path}\nThis cannot be undone. Continue?`))) return;
  if (!(await ctx.ui.confirm("Confirm permanent deletion again", `Delete the original files for ${resourceId}?`))) return;
  const typed = await ctx.ui.input(`Type ${resourceId} to delete`, "");
  if (typed !== resourceId) return notify(ctx, "Resource name did not match; local files were preserved.", "warning");
  await rm(path, { recursive: true, force: true });
  notify(ctx, `Permanently deleted ${path}.`, "warning");
}

async function pendingImportedUnits(root, currentBundle, run) {
  const result = await run("git", ["show", "HEAD:bundle.json"], { cwd: root });
  if (result.code !== 0) return [];
  const previous = JSON.parse(result.stdout);
  const previousPackages = new Map(previous.packages.map((pkg) => [pkg.id, pkg]));
  const previousResources = new Map(previous.resources.map((resource) => [resource.id, resource]));
  return [
    ...currentBundle.packages
      .filter((pkg) => JSON.stringify(previousPackages.get(pkg.id)) !== JSON.stringify(pkg))
      .map((value) => ({ kind: "package", id: value.id, value })),
    ...currentBundle.resources
      .filter((resource) => JSON.stringify(previousResources.get(resource.id)) !== JSON.stringify(resource))
      .map((value) => ({ kind: "resource", id: value.id, value })),
  ];
}

async function cleanupNewDirectInstalls(ctx, runtime, units) {
  for (const unit of units) {
    if (!(await ctx.ui.confirm("Remove newly bundled direct install?", `${unit.id}\nRecommended to avoid duplicate loading after reload.`))) continue;
    await uninstallCurrentMachine(ctx, runtime, unit);
  }
}

async function assertWritableRuntime(runtime) {
  if (!runtime.managedInstall) {
    throw new Error("Write commands only work from Pi's managed rolling install. Install git:github.com/yqwu905/pi without a tag");
  }
  const git = await inspectGit(runtime.root, runtime.run, { fetch: false });
  if (git.detached || git.branch !== "main") {
    throw new Error("Write commands require an unpinned rolling install on branch main");
  }
}

function requireInteractive(ctx, action) {
  if (!ctx.hasUI) throw new Error(`/package ${action} requires interactive or RPC UI`);
}

function validateResourceName(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) {
    throw new Error("Resource name must use lowercase letters, digits, dot, underscore, or hyphen");
  }
  return name;
}

function countResources(resources) {
  return Object.values(resources).reduce((count, paths) => count + paths.length, 0);
}

function notify(ctx, message, level) {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}
