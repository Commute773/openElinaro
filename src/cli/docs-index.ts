import { DocsIndexService } from "../services/docs-index-service";

const service = new DocsIndexService();
const report = service.sync();

console.log(JSON.stringify({
  ok: true,
  generatedAt: report.generatedAt,
  changedFiles: report.changedFiles,
  orphanDocs: report.orphanDocs,
  missingDocTargets: report.missingDocTargets,
}, null, 2));
