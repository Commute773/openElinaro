import { LongMemEvalBenchmarkService, type LongMemEvalDatasetName } from "../services/longmemeval-benchmark-service";
import { getUserDataRootDir } from "../services/runtime-root";

function printUsage() {
  console.log(
    [
      "Usage: bun src/cli/longmemeval-memory-benchmark.ts [options]",
      "",
      "Options:",
      "  --dataset <longmemeval_s_cleaned|longmemeval_oracle>",
      "  --limit <n>",
      "  --top-k <5|10>",
      "  --profile <profile-id>",
      "  --sample-strategy <round_robin_question_type|first_n>",
      "",
      "Default:",
      "  --dataset longmemeval_s_cleaned --limit 8 --top-k 10 --profile root --sample-strategy round_robin_question_type",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]) {
  const parsed = {
    dataset: "longmemeval_s_cleaned" as LongMemEvalDatasetName,
    limit: 8,
    topK: 10 as 5 | 10,
    profileId: "root",
    sampleStrategy: "round_robin_question_type" as "round_robin_question_type" | "first_n",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    switch (argument) {
      case "--dataset":
        if (next !== "longmemeval_s_cleaned" && next !== "longmemeval_oracle") {
          throw new Error(`Unsupported dataset: ${next ?? "(missing)"}`);
        }
        parsed.dataset = next;
        index += 1;
        break;
      case "--limit":
        parsed.limit = Math.max(1, Number.parseInt(next ?? "", 10) || parsed.limit);
        index += 1;
        break;
      case "--top-k":
        if (next !== "5" && next !== "10") {
          throw new Error(`Unsupported top-k: ${next ?? "(missing)"}`);
        }
        parsed.topK = Number.parseInt(next, 10) as 5 | 10;
        index += 1;
        break;
      case "--profile":
        parsed.profileId = (next ?? "").trim() || parsed.profileId;
        index += 1;
        break;
      case "--sample-strategy":
        if (next !== "round_robin_question_type" && next !== "first_n") {
          throw new Error(`Unsupported sample strategy: ${next ?? "(missing)"}`);
        }
        parsed.sampleStrategy = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        if (argument?.startsWith("-")) {
          throw new Error(`Unknown option: ${argument}`);
        }
        break;
    }
  }

  return parsed;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const service = new LongMemEvalBenchmarkService(getUserDataRootDir(), process.cwd());
  const result = await service.run(config);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
