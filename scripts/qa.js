"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function filesUnder(dir, suffix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

const jsFiles = [
  ...filesUnder(path.join(root, "src"), ".js"),
  ...filesUnder(path.join(root, "popup"), ".js"),
  ...filesUnder(path.join(root, "scripts"), ".js"),
  ...filesUnder(path.join(root, "tests"), ".js")
];

for (const file of jsFiles) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    process.stderr.write(check.stderr || check.stdout);
    process.exit(check.status || 1);
  }
}

const testFiles = filesUnder(path.join(root, "tests"), ".test.js");
const tests = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  encoding: "utf8"
});
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
process.exit(tests.status || 0);
