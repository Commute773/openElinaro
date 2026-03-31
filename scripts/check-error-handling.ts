/**
 * AST-based checker: every catch block must either log or go through typed utilities.
 *
 * Compliant catch bodies contain one of:
 *   - `recordError`       — telemetry.recordError (unexpected error, logged)
 *   - `fail(`             — result.ts fail() (explicit failure, logged)
 *   - `throw` / `reject(` — error propagated to caller
 *   - `console.error`     — direct console logging (CLI scripts)
 *
 * Raw try/catch with none of the above is a build error.
 * Use attempt/attemptOr/attemptAsync/attemptOrAsync for expected failures —
 * those live in result.ts (exempt) so their internal catches don't trigger.
 *
 * Commands:
 *   bun scripts/check-error-handling.ts           — check (strict, no baseline)
 *   bun scripts/check-error-handling.ts --baseline — save current violations as baseline
 *   bun scripts/check-error-handling.ts --lenient  — only fail on violations not in baseline
 */
import { Glob } from "bun";
import ts from "typescript";

const BASELINE_PATH = ".error-handling-baseline.json";

const ALLOWED_MARKERS = [
  "recordError",
  "fail(",
  "throw ",
  "throw;",
  "reject(",
  "console.error",
];

const EXEMPT_FILES = new Set([
  "src/utils/result.ts",
  "src/services/infrastructure/telemetry.ts",
  "src/utils/sqlite-helpers.ts",
]);

type Violation = {
  key: string;
  file: string;
  line: number;
  preview: string;
};

function checkNode(
  node: ts.Node,
  source: string,
  file: string,
  sourceFile: ts.SourceFile,
  violations: Violation[],
) {
  if (ts.isCatchClause(node)) {
    const blockText = source.slice(node.block.pos, node.block.end);
    if (!ALLOWED_MARKERS.some((m) => blockText.includes(m))) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const catchLine = source.split("\n")[line] ?? "";
      violations.push({
        key: `${file}:${line + 1}`,
        file,
        line: line + 1,
        preview: catchLine.trim(),
      });
    }
  }

  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "catch" &&
    node.arguments.length > 0
  ) {
    const arg = node.arguments[0]!;
    const argText = source.slice(arg.pos, arg.end);
    if (!ALLOWED_MARKERS.some((m) => argText.includes(m))) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const catchLine = source.split("\n")[line] ?? "";
      violations.push({
        key: `${file}:${line + 1}`,
        file,
        line: line + 1,
        preview: catchLine.trim(),
      });
    }
  }

  ts.forEachChild(node, (child) =>
    checkNode(child, source, file, sourceFile, violations),
  );
}

async function findAllViolations(): Promise<Violation[]> {
  const glob = new Glob("src/**/*.ts");
  const violations: Violation[] = [];

  for await (const filePath of glob.scan({ cwd: process.cwd() })) {
    if (EXEMPT_FILES.has(filePath)) continue;
    if (filePath.endsWith(".test.ts")) continue;
    if (filePath.includes(".e2e.")) continue;

    const source = await Bun.file(filePath).text();
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    checkNode(sourceFile, source, filePath, sourceFile, violations);
  }

  return violations;
}

async function loadBaseline(): Promise<Set<string>> {
  try {
    const data = await Bun.file(BASELINE_PATH).json();
    return new Set(data as string[]);
  } catch {
    return new Set();
  }
}

async function saveBaseline(violations: Violation[]) {
  const keys = violations.map((v) => v.key).sort();
  await Bun.write(BASELINE_PATH, JSON.stringify(keys, null, 2) + "\n");
  console.log(`check-error-handling: baseline saved with ${keys.length} entries`);
}

function reportViolations(violations: Violation[], label: string) {
  console.error(`\ncheck-error-handling: ${violations.length} ${label}\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.preview}\n`);
  }
  console.error(
    "Fix: use attempt/attemptOr/attemptAsync/attemptOrAsync for expected failures,",
  );
  console.error(
    "     or tryCatch/tryCatchAsync/recordError/fail() for unexpected errors.\n",
  );
  console.error(
    "     All utilities: src/utils/result.ts\n",
  );
}

async function main() {
  const mode = process.argv[2];
  const violations = await findAllViolations();

  if (mode === "--baseline") {
    await saveBaseline(violations);
    return;
  }

  if (mode === "--lenient") {
    const baseline = await loadBaseline();
    const newViolations = violations.filter((v) => !baseline.has(v.key));
    if (newViolations.length === 0) {
      console.log(`check-error-handling: ${baseline.size} baselined, no new violations`);
      return;
    }
    reportViolations(newViolations, "NEW unlogged catch site(s)");
    process.exit(1);
  }

  // Default: strict mode — no baseline, all violations fail
  if (violations.length === 0) {
    console.log("check-error-handling: all catch sites handled");
    return;
  }

  reportViolations(violations, "unlogged catch site(s)");
  process.exit(1);
}

main();
