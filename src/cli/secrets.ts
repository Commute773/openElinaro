import { SECRET_STORE_KINDS, SecretStoreService, readSecretJsonFromStdin } from "../services/secret-store-service";

function usage() {
  return [
    "Usage:",
    "  bun src/cli/secrets.ts status",
    "  bun src/cli/secrets.ts list",
    "  bun src/cli/secrets.ts set-json <name> [kind] < secret.json",
    "  bun src/cli/secrets.ts import-file <name> <path> [kind]",
    "  bun src/cli/secrets.ts generate-password <name> [fieldName] [length] [kind]",
    "  bun src/cli/secrets.ts delete <name>",
    "",
    `Kinds: ${SECRET_STORE_KINDS.join(", ")}`,
    "",
    "The secret payload must be a flat JSON object with scalar values only.",
  ].join("\n");
}

function parseKind(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (!SECRET_STORE_KINDS.includes(value as (typeof SECRET_STORE_KINDS)[number])) {
    throw new Error(`Invalid secret kind "${value}". Expected one of: ${SECRET_STORE_KINDS.join(", ")}.`);
  }
  return value as (typeof SECRET_STORE_KINDS)[number];
}

const [command, ...args] = process.argv.slice(2);
const secrets = new SecretStoreService();

try {
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    process.exit(0);
  }

  if (command === "status") {
    const status = secrets.getStatus();
    console.log([
      `profile: ${status.profileId}`,
      `configured: ${status.configured ? "yes" : "no"}`,
      `key source: ${status.keySource}`,
      `secret count: ${status.secretCount}`,
      `store: ${status.storePath}`,
    ].join("\n"));
    process.exit(0);
  }

  if (command === "list") {
    const status = secrets.getStatus();
    const entries = secrets.listSecrets();
    if (entries.length === 0) {
      console.log(
        `No secrets stored for profile ${status.profileId}. Secret store key: ${status.configured ? "configured" : "missing"}.`,
      );
      process.exit(0);
    }
    console.log(entries.map((entry) =>
      `${entry.name} | kind=${entry.kind} | fields=${entry.fields.join(",")} | updated=${entry.updatedAt}`
    ).join("\n"));
    process.exit(0);
  }

  if (command === "set-json") {
    const [name, kindArg] = args;
    if (!name) {
      throw new Error("set-json requires <name>.");
    }
    const saved = secrets.saveSecret({
      name,
      kind: parseKind(kindArg),
      fields: readSecretJsonFromStdin(),
    });
    console.log(
      `Stored ${saved.name} for profile ${saved.profileId} with fields: ${saved.fields.join(", ")}.`,
    );
    process.exit(0);
  }

  if (command === "import-file") {
    const [name, sourcePath, kindArg] = args;
    if (!name || !sourcePath) {
      throw new Error("import-file requires <name> and <path>.");
    }
    const saved = secrets.importSecretFromFile({
      name,
      sourcePath,
      kind: parseKind(kindArg),
    });
    console.log(
      `Stored ${saved.name} for profile ${saved.profileId} with fields: ${saved.fields.join(", ")}.`,
    );
    process.exit(0);
  }

  if (command === "delete") {
    const [name] = args;
    if (!name) {
      throw new Error("delete requires <name>.");
    }
    const existed = secrets.deleteSecret(name);
    console.log(existed ? `Deleted ${name}.` : `Secret ${name} was already missing.`);
    process.exit(0);
  }

  if (command === "generate-password") {
    const [name, fieldName, lengthArg, kindArg] = args;
    if (!name) {
      throw new Error("generate-password requires <name>.");
    }
    let parsedLength: number | undefined;
    if (lengthArg) {
      parsedLength = Number.parseInt(lengthArg, 10);
    }
    if (lengthArg && (parsedLength === undefined || !Number.isFinite(parsedLength) || parsedLength < 8)) {
      throw new Error(`Invalid password length "${lengthArg}".`);
    }
    const saved = secrets.generateAndStorePassword({
      name,
      fieldName,
      length: parsedLength,
      kind: parseKind(kindArg),
    });
    console.log(
      `Generated and stored a ${saved.generatedLength}-character password in ${saved.name}.${saved.fieldName} for profile ${saved.profileId}.`,
    );
    process.exit(0);
  }

  throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
}
