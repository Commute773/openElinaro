import { SweBenchDifficultyAnalysisService } from "../services/swebench-difficulty-analysis-service";

function printUsage() {
  console.log(
    [
      "Usage: bun src/cli/swebench-verified-difficulty-analysis.ts [options]",
      "",
      "Options:",
      "  --min-submission-coverage <n>",
      "  --min-task-attempts <n>",
      "  --laplace-alpha <n>",
      "  --laplace-beta <n>",
      "  --top <n>",
      "",
      "Default:",
      "  --min-submission-coverage 450 --min-task-attempts 5 --laplace-alpha 1 --laplace-beta 1 --top 15",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]) {
  const parsed = {
    minSubmissionCoverage: 450,
    minTaskAttempts: 5,
    laplaceAlpha: 1,
    laplaceBeta: 1,
    top: 15,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];

    switch (argument) {
      case "--min-submission-coverage":
        parsed.minSubmissionCoverage = Math.max(0, Number.parseInt(next ?? "", 10) || parsed.minSubmissionCoverage);
        index += 1;
        break;
      case "--min-task-attempts":
        parsed.minTaskAttempts = Math.max(1, Number.parseInt(next ?? "", 10) || parsed.minTaskAttempts);
        index += 1;
        break;
      case "--laplace-alpha":
        parsed.laplaceAlpha = Math.max(0, Number.parseFloat(next ?? "") || parsed.laplaceAlpha);
        index += 1;
        break;
      case "--laplace-beta":
        parsed.laplaceBeta = Math.max(0, Number.parseFloat(next ?? "") || parsed.laplaceBeta);
        index += 1;
        break;
      case "--top":
        parsed.top = Math.max(1, Number.parseInt(next ?? "", 10) || parsed.top);
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
  const args = parseArgs(process.argv.slice(2));
  const service = new SweBenchDifficultyAnalysisService(process.cwd());
  const result = await service.run({
    minSubmissionCoverage: args.minSubmissionCoverage,
    minTaskAttempts: args.minTaskAttempts,
    laplaceAlpha: args.laplaceAlpha,
    laplaceBeta: args.laplaceBeta,
  });

  console.log(JSON.stringify({
    benchmark: result.benchmark,
    generatedAt: result.generatedAt,
    outputPath: result.outputPath,
    submissionsSeen: result.submissionsSeen,
    submissionsIncluded: result.submissionsIncluded,
    tasksConsidered: result.tasksConsidered,
    topSubmissions: result.submissions.slice(0, args.top),
    hardestTasks: result.tasks.slice(0, args.top),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
