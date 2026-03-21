import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { HealthTrackingService } from "./health-tracking-service";

function createService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-health-"));
  return new HealthTrackingService({
    storePath: path.join(root, "checkins.json"),
    importedDir: path.join(root, "imported"),
  });
}

describe("HealthTrackingService", () => {
  test("parses imported markdown check-ins into summary/history", () => {
    const service = createService();
    const importedPath = path.join(service.getImportedDir(), "health.md");
    fs.writeFileSync(importedPath, [
      "## 2026-03-10 - Morning stimulant/anxiety check (8:37 AM)",
      "- **Anxiety:** 6/10",
      "- **Caffeine:** 150mg",
      "- **Dextroamphetamine:** 10mg",
      "- **Notes:** Morning stack felt anxiety-provoking.",
      "",
    ].join("\n"));

    const summary = service.summary();
    const history = service.history(5);

    expect(summary).toContain("Latest health check-in:");
    expect(summary).toContain("anxiety 6/10");
    expect(history).toContain("Morning stack felt anxiety-provoking");
  });

  test("records structured health check-ins", () => {
    const service = createService();
    service.logCheckin({
      kind: "evening",
      energy: 4,
      mood: 7,
      dizziness: "none",
      meals: ["coffee", "farmers wrap"],
      notes: "Low energy, decent mood.",
    });

    const history = service.history(1);
    expect(history).toContain("energy 4/10");
    expect(history).toContain("mood 7/10");
    expect(history).toContain("farmers wrap");
  });
});
