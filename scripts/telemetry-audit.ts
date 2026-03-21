import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  "src/app",
  "src/auth",
  "src/integrations",
  "src/orchestration",
  "src/services",
  "src/tools",
  "src/workers",
];

const EXPLICIT_TELEMETRY_PATTERN =
  /telemetry\.child|telemetry\.event|traceSpan\(|\.span\(|instrumentFetch\(|instrumentSpawn\(|instrumentStoreWrite\(|instrumentQueueAction\(/;

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(next, out);
      continue;
    }
    if (entry.isFile() && next.endsWith(".ts") && !next.endsWith(".test.ts")) {
      out.push(next);
    }
  }
  return out;
}

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function collectAutoInstrumentedClasses(files: string[]) {
  const classes = new Set<string>();
  for (const file of files) {
    const text = read(file);
    const pattern = /instrumentMethods\(\s*new\s+([A-Za-z0-9_]+)/g;
    let match: RegExpExecArray | null;
    for (;;) {
      match = pattern.exec(text);
      if (!match) {
        break;
      }
      classes.add(match[1] ?? "");
    }
  }
  return classes;
}

function collectExportedClasses(file: string) {
  const text = read(file);
  const pattern = /export\s+class\s+([A-Za-z0-9_]+)/g;
  const classes: string[] = [];
  let match: RegExpExecArray | null;
  for (;;) {
    match = pattern.exec(text);
    if (!match) {
      break;
    }
    if (match[1]) {
      classes.push(match[1]);
    }
  }
  return {
    classes,
    hasExplicitTelemetry: EXPLICIT_TELEMETRY_PATTERN.test(text),
  };
}

const files = ROOTS.flatMap((root) => (fs.existsSync(root) ? walk(root) : [])).sort();
const autoInstrumentedClasses = collectAutoInstrumentedClasses(files);
const findings: Array<{ file: string; classes: string[] }> = [];
const autoCovered: Array<{ file: string; classes: string[] }> = [];

for (const file of files) {
  const { classes, hasExplicitTelemetry } = collectExportedClasses(file);
  if (classes.length === 0 || hasExplicitTelemetry) {
    continue;
  }
  const covered = classes.filter((name) => autoInstrumentedClasses.has(name));
  const uncovered = classes.filter((name) => !autoInstrumentedClasses.has(name));
  if (covered.length > 0) {
    autoCovered.push({ file, classes: covered });
  }
  if (uncovered.length > 0) {
    findings.push({ file, classes: uncovered });
  }
}

console.log("Telemetry audit");
console.log(`Scanned ${files.length} runtime files.`);
console.log(`Auto-instrumented classes detected: ${autoInstrumentedClasses.size}.`);
console.log("");

if (autoCovered.length > 0) {
  console.log("Covered by composition-root auto instrumentation:");
  for (const entry of autoCovered) {
    console.log(`- ${entry.file}: ${entry.classes.join(", ")}`);
  }
  console.log("");
}

if (findings.length === 0) {
  console.log("No exported runtime classes were found without explicit telemetry or auto instrumentation.");
  process.exit(0);
}

console.log("Exported runtime classes missing explicit telemetry and auto instrumentation:");
for (const entry of findings) {
  console.log(`- ${entry.file}: ${entry.classes.join(", ")}`);
}

if (process.argv.includes("--strict")) {
  process.exit(1);
}
