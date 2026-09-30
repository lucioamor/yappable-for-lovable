#!/usr/bin/env node
/**
 * npm run package
 * Zips only the files needed by the Chrome Web Store.
 * Output: yappable-for-lovable-<version>.zip (repo root)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;
const outFile = path.join(root, `yappable-for-lovable-${version}.zip`);

const include = [
  "manifest.json",
  "rules.json",
  "src",
  "popup",
  "icons",
  "assets",
];

// Remove previous zip if it exists
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

// Filter to only existing entries (avoids errors on missing optional dirs)
const existing = include.filter((p) => fs.existsSync(path.join(root, p)));

if (process.platform === "win32") {
  // PowerShell 7 keeps project paths and filenames UTF-8 safe.
  const psItems = existing.map((p) => `"${path.join(root, p)}"`).join(",");
  execSync(
    `pwsh -NoProfile -Command "Compress-Archive -Path ${psItems} -DestinationPath '${outFile}'"`,
    { cwd: root, stdio: "inherit" }
  );
} else {
  const targets = existing.join(" ");
  execSync(`zip -r "${outFile}" ${targets}`, { cwd: root, stdio: "inherit" });
}

console.log(`\n✔ Created: ${path.basename(outFile)}`);
