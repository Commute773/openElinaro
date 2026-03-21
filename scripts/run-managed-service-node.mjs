#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const serviceRoot = process.env.OPENELINARO_SERVICE_ROOT_DIR || process.cwd();
const bunBin = process.env.BUN_BIN || process.argv[2];
const appEntrypoint = process.env.OPENELINARO_APP_ENTRYPOINT || process.argv[3];
const rootDir = process.env.OPENELINARO_ROOT_DIR || process.argv[4];
const explicitServiceRoot = process.env.OPENELINARO_SERVICE_ROOT_DIR || process.argv[5];
const appArgs = process.argv.slice(6);

if (!bunBin) {
  console.error("Missing bun path for managed service wrapper.");
  process.exit(1);
}

if (!appEntrypoint) {
  console.error("Missing app entrypoint path for managed service wrapper.");
  process.exit(1);
}

if (rootDir) {
  process.env.OPENELINARO_ROOT_DIR = rootDir;
}

if (explicitServiceRoot) {
  process.env.OPENELINARO_SERVICE_ROOT_DIR = explicitServiceRoot;
}

const child = spawn(bunBin, [appEntrypoint, ...appArgs], {
  cwd: explicitServiceRoot || serviceRoot,
  env: process.env,
  stdio: "inherit",
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
