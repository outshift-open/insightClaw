import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const artifactDir = join(root, "artifact");
const packageDir = join(artifactDir, "package");

rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });

const packageJsonPath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

packageJson.openclaw = {
  ...(packageJson.openclaw ?? {}),
  extensions: ["./dist/index.js"],
};

const filesToCopy = [
  "dist",
  "instrumentation",
  "README.md",
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