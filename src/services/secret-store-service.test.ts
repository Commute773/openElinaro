import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  SecretStoreService,
} from "./secret-store-service";

const tempDirs: string[] = [];
let previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
const previousCwd = process.cwd();

function withRuntimeRoot() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-secret-store-"));
  tempDirs.push(runtimeRoot);
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  process.chdir(runtimeRoot);
  return runtimeRoot;
}

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  process.chdir(previousCwd);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SecretStoreService", () => {
  test("stores secret data and resolves refs from the unified store", () => {
    const runtimeRoot = withRuntimeRoot();

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "prepaid_card",
      kind: "payment_card",
      fields: {
        number: "4111111111111111",
        expMonth: "12",
        expYear: "2030",
      },
      profileId: "root",
    });

    const storeText = fs.readFileSync(path.join(runtimeRoot, ".openelinarotest", "secret-store.json"), "utf8");
    expect(storeText.includes("4111111111111111")).toBe(true);

    const listed = secrets.listSecrets("root");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "prepaid_card",
      kind: "payment_card",
      fields: ["expMonth", "expYear", "number"],
    });

    expect(secrets.resolveSecretRef("prepaid_card.number", "root")).toBe("4111111111111111");
  });

  test("imports from a json file", () => {
    const runtimeRoot = withRuntimeRoot();

    const sourcePath = path.join(runtimeRoot, "prepaid-card.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        cardholderName: "Test User",
        number: "4242424242424242",
        expMonth: 1,
        expYear: 2031,
      }, null, 2)}\n`,
    );

    const secrets = new SecretStoreService();
    const saved = secrets.importSecretFromFile({
      name: "browser_checkout",
      sourcePath,
      kind: "payment_card",
    });

    expect(saved.fields).toEqual(["cardholderName", "expMonth", "expYear", "number"]);
    expect(secrets.resolveSecretRef("browser_checkout.expMonth")).toBe("1");
  });

  test("generates and stores a password without dropping existing fields", () => {
    withRuntimeRoot();

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "github_credentials",
      kind: "password",
      fields: {
        username: "robot-user",
      },
    });

    const saved = secrets.generateAndStorePassword({
      name: "github_credentials",
      fieldName: "password",
      length: 32,
    });

    expect(saved.kind).toBe("password");
    expect(saved.fieldName).toBe("password");
    expect(saved.generatedLength).toBe(32);
    expect(saved.fields).toEqual(["password", "username"]);
    expect(saved.preservedFieldCount).toBe(1);

    const password = secrets.resolveSecretRef("github_credentials.password");
    expect(password).toHaveLength(32);
    expect(secrets.resolveSecretRef("github_credentials.username")).toBe("robot-user");
  });

  test("lists metadata and allows save/resolve without an external key", () => {
    withRuntimeRoot();

    const secrets = new SecretStoreService();
    const status = secrets.getStatus();
    expect(status.configured).toBe(true);
    expect(secrets.listSecrets()).toEqual([]);
    secrets.saveSecret({
      name: "prepaid_card",
      fields: { number: "4111111111111111" },
    });
    expect(secrets.resolveSecretRef("prepaid_card.number")).toBe("4111111111111111");
  });
});
