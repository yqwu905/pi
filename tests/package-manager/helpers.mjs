import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function temporaryDirectory(prefix = "pi-package-test-") {
  return mkdtemp(`${tmpdir()}/${prefix}`);
}

export async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30000,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      code: typeof error.code === "number" ? error.code : 1,
      killed: Boolean(error.killed),
    };
  }
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function managerResource() {
  return {
    id: "extension:package-manager",
    type: "extension",
    name: "package-manager",
    path: "extensions/package-manager/index.ts",
    contentRoot: "extensions/package-manager",
    source: { type: "builtin" },
    protected: true,
  };
}

export function baseBundle() {
  return {
    schemaVersion: 1,
    package: {
      name: "@test/pi",
      repository: "https://github.com/test/pi.git",
      branch: "main",
      remote: "origin",
      installSource: "git:github.com/test/pi",
    },
    packages: [],
    resources: [managerResource()],
  };
}
