import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandCompletions, handlePackageCommand } from "./commands.mjs";
import { normalizeRepository } from "./git.mjs";

const PACKAGE_REPOSITORY = "https://github.com/yqwu905/pi.git";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default function packageManagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("package", {
    description: "Manage the installed yqwu905/pi extension and skill bundle",
    getArgumentCompletions: commandCompletions,
    handler: async (args, ctx) => {
      try {
        const runtime = createRuntime(pi, ctx);
        await handlePackageCommand(args, ctx, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Package manager: ${message}`, "error");
        else console.error(`Package manager: ${message}`);
      }
    },
  });
}

function createRuntime(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const packageManager = new DefaultPackageManager({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
  });
  const configured = packageManager.listConfiguredPackages();
  const ownPackage = configured.find(
    (entry) => normalizeRepository(stripGitRef(entry.source)) === normalizeRepository(PACKAGE_REPOSITORY),
  );
  const installedPath = ownPackage?.installedPath;
  const managedInstall = Boolean(installedPath && sameRealPath(installedPath, PACKAGE_ROOT));
  return {
    pi,
    root: PACKAGE_ROOT,
    agentDir,
    packageManager,
    settingsManager,
    managedInstall,
    stateRoot: join(agentDir, "package-manager-state", "yqwu905-pi"),
    ownSource: ownPackage?.source,
    run: (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) =>
      pi.exec(command, args, options),
  };
}

function stripGitRef(source: string): string {
  if (!source.startsWith("git:")) return source;
  const value = source.slice(4);
  const refSeparator = value.lastIndexOf("@");
  const slash = value.lastIndexOf("/");
  return refSeparator > slash ? value.slice(0, refSeparator) : value;
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
