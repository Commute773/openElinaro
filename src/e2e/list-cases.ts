/**
 * Helper: prints test case names (with optional tag/name filtering) as JSON.
 *
 * Usage:
 *   bun run src/e2e/list-cases.ts                         # all names as JSON array
 *   bun run src/e2e/list-cases.ts --human                 # human-readable list
 *   bun run src/e2e/list-cases.ts --tag todo              # filter by tag
 *   bun run src/e2e/list-cases.ts --name basic-chat-greeting --name todo-add
 */
import { TEST_CASES } from "./test-cases";

const args = process.argv.slice(2);
let human = false;
const names: string[] = [];
const tags: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if (arg === "--human") {
    human = true;
  } else if (arg === "--tag" && next) {
    tags.push(next);
    i++;
  } else if (arg === "--name" && next) {
    names.push(next);
    i++;
  }
}

let cases = TEST_CASES;
if (names.length > 0) {
  cases = cases.filter((c) => names.includes(c.name));
}
if (tags.length > 0) {
  cases = cases.filter((c) => c.tags?.some((t) => tags.includes(t)));
}

if (human) {
  for (const tc of cases) {
    const tagStr = tc.tags?.length ? ` [${tc.tags.join(", ")}]` : "";
    console.log(`  ${tc.name}${tagStr}`);
  }
} else {
  console.log(JSON.stringify(cases.map((c) => c.name)));
}
