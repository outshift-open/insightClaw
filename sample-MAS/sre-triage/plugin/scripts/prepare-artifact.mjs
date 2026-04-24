import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const artifactDir = join(root, "artifact");
const packageDir = join(artifactDir, "package");

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

const packageJsonPath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Inject a postinstall to ensure bash scripts are executable after npm install
packageJson.scripts = {
  ...(packageJson.scripts ?? {}),
  postinstall: "chmod +x ./scripts/*.sh",
};

const filesToCopy = [
  "index.ts",
  "scripts",
  "openclaw.plugin.json",
  "package-lock.json",
];

for (const relativePath of filesToCopy) {
  const sourcePath = join(root, relativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Required artifact input missing: ${relativePath}`);
  }

  cpSync(sourcePath, join(packageDir, relativePath), { recursive: true });
}

writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`Prepared artifact package at ${packageDir}`);
