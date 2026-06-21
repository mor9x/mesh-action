import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type PackageJson = {
  dependencies?: Record<string, string>;
};

const packageRoot = path.resolve(process.cwd(), "node_modules/suimesh");
const packageJsonPath = path.join(packageRoot, "package.json");

function runOrThrow(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run ${command} ${args.join(" ")} in ${cwd} (exit ${result.status ?? "unknown"})`
    );
  }
}

function requestedVersion() {
  const rootPackage = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as PackageJson;
  return rootPackage.dependencies?.suimesh ?? "latest";
}

if (!existsSync(packageJsonPath)) {
  throw new Error(
    "Missing node_modules/suimesh/package.json. Install dependencies first with npm install."
  );
}

if (!lstatSync(packageJsonPath).isSymbolicLink()) {
  console.log("suimesh install is already materialized");
  process.exit(0);
}

const version = requestedVersion();
const cacheRoot = path.resolve(process.cwd(), ".tmp/npm-cache");
mkdirSync(cacheRoot, { recursive: true });

const installRoot = mkdtempSync(path.join(tmpdir(), "meshaction-suimesh-fix-"));
const env = {
  ...process.env,
  NPM_CONFIG_CACHE: cacheRoot,
};

try {
  runOrThrow("npm", ["init", "-y"], installRoot, env);
  runOrThrow("npm", ["install", `suimesh@${version}`], installRoot, env);

  const cleanPackageRoot = path.join(installRoot, "node_modules", "suimesh");
  if (!existsSync(cleanPackageRoot)) {
    throw new Error(`Clean suimesh install missing at ${cleanPackageRoot}`);
  }

  rmSync(packageRoot, { recursive: true, force: true });
  cpSync(cleanPackageRoot, packageRoot, {
    recursive: true,
    force: true,
  });

  console.log(`Repaired symlinked suimesh install using npm package ${version}`);
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
