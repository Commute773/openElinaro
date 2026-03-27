/**
 * E2E runner: routine tool invocations through the real runtime.
 *
 * Tests routine_add → routine_list → routine_done → routine_delete via
 * invokeRoutineTool (the same path used by both Discord and the function layer).
 *
 * This does NOT call an LLM — it invokes tools directly, so no API cost.
 * The test validates that the function layer bridge works end-to-end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestFixturesDir } from "../test/fixtures";

// Set up isolated runtime root BEFORE importing any runtime modules
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-routine-e2e-"));
process.env.OPENELINARO_ROOT_DIR = testRoot;

// Copy auth credentials from test fixtures
const fixturesDir = getTestFixturesDir();
const authSrc = path.join(fixturesDir, "auth-store.json");
if (fs.existsSync(authSrc)) {
  fs.mkdirSync(testRoot, { recursive: true });
  fs.copyFileSync(authSrc, path.join(testRoot, "auth-store.json"));
}

// Copy minimal profile registry
const profilesSrc = path.join(fixturesDir, "profiles");
if (fs.existsSync(profilesSrc)) {
  fs.cpSync(profilesSrc, path.join(testRoot, "profiles"), { recursive: true });
}

// Import runtime after env is configured
const { OpenElinaroApp } = await import("./runtime");

try {
  const app = new OpenElinaroApp();

  // 1. Add a routine
  const addResult = await app.invokeRoutineTool("routine_add", {
    title: "E2E Test Routine",
    kind: "todo",
    scheduleKind: "manual",
  }, { conversationKey: "e2e-test" });

  if (typeof addResult === "string" && addResult.includes("Saved routine item")) {
    console.log("ROUTINE_E2E_ADD_OK");
  } else {
    console.log(`ROUTINE_E2E_ADD_FAIL: ${addResult}`);
  }

  // Extract the item id from the add result
  const idMatch = (addResult as string).match(/Saved routine item (\S+):/);
  const itemId = idMatch?.[1];

  if (!itemId) {
    console.log("ROUTINE_E2E_FAIL: Could not extract item id from add result");
    process.exit(1);
  }

  // 2. List routines (should include our item)
  const listResult = await app.invokeRoutineTool("routine_list", {
    kind: "todo",
  }, { conversationKey: "e2e-test" });

  if (typeof listResult === "string" && listResult.includes("E2E Test Routine")) {
    console.log("ROUTINE_E2E_LIST_OK");
  } else {
    console.log(`ROUTINE_E2E_LIST_FAIL: ${listResult}`);
  }

  // 3. Mark done
  const doneResult = await app.invokeRoutineTool("routine_done", {
    id: itemId,
  }, { conversationKey: "e2e-test" });

  if (typeof doneResult === "string" && doneResult.includes("Marked done")) {
    console.log("ROUTINE_E2E_DONE_OK");
  } else {
    console.log(`ROUTINE_E2E_DONE_FAIL: ${doneResult}`);
  }

  // 4. Delete
  const deleteResult = await app.invokeRoutineTool("routine_delete", {
    id: itemId,
  }, { conversationKey: "e2e-test" });

  if (typeof deleteResult === "string" && deleteResult.includes("Deleted routine item")) {
    console.log("ROUTINE_E2E_DELETE_OK");
  } else {
    console.log(`ROUTINE_E2E_DELETE_FAIL: ${deleteResult}`);
  }
} finally {
  // Cleanup
  fs.rmSync(testRoot, { recursive: true, force: true });
}
