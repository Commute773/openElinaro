/**
 * E2e tests for MediaService using a copy of the production media config.
 *
 * Copies catalog and media files from ~/.openelinaro/media/ into an isolated
 * temp directory so tests never touch the live state.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MediaService } from "../media-service";

const PROD_MEDIA_ROOT = path.join(os.homedir(), ".openelinaro", "media");
const HAS_PROD_MEDIA =
  fs.existsSync(path.join(PROD_MEDIA_ROOT, "catalog.json")) &&
  fs.existsSync(path.join(PROD_MEDIA_ROOT, "songs")) &&
  fs.existsSync(path.join(PROD_MEDIA_ROOT, "ambience"));

describe("media service e2e", () => {
  const run = HAS_PROD_MEDIA ? test : test.skip;

  let tmpRoot: string;
  let mediaRoot: string;
  let service: MediaService;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oe-media-e2e-"));
    mediaRoot = path.join(tmpRoot, "media");
    fs.cpSync(PROD_MEDIA_ROOT, mediaRoot, { recursive: true });

    // Remove any stale player metadata / logs from the copy
    for (const subdir of ["players", "logs"]) {
      const dir = path.join(mediaRoot, subdir);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }

    service = new MediaService({
      mediaRoots: [mediaRoot],
      catalogPath: path.join(mediaRoot, "catalog.json"),
      speakerConfigPath: path.join(mediaRoot, "speakers.json"),
      stateRoot: path.join(tmpRoot, "state"),
      socketRoot: path.join(tmpRoot, "sockets"),
    });
  });

  afterAll(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Catalog parsing
  // -------------------------------------------------------------------------

  run("listMedia returns all catalog tracks", () => {
    const result = service.listMedia({ limit: 50 });
    expect(result.total).toBeGreaterThanOrEqual(8);
    expect(result.counts.songs).toBeGreaterThanOrEqual(7);
    expect(result.counts.ambience).toBeGreaterThanOrEqual(1);
  });

  run("catalog entries have correct titles from catalog.json", () => {
    const result = service.listMedia({ limit: 50 });
    const titles = result.items.map((item) => item.title);
    expect(titles).toContain("Darling Dance");
    expect(titles).toContain("Mesmerizer");
    expect(titles).toContain("God-ish");
    expect(titles).toContain("Rabbit Hole");
    expect(titles).toContain("Vampire");
    expect(titles).toContain("Hated by Life");
    expect(titles).toContain("Machine Love");
    expect(titles).toContain("Thunder");
  });

  run("catalog entries have tags from catalog.json", () => {
    const result = service.listMedia({ query: "Darling Dance", limit: 1 });
    expect(result.items.length).toBe(1);
    const item = result.items[0]!;
    expect(item.tags).toContain("vocaloid");
    expect(item.tags).toContain("hatsune-miku");
    expect(item.tags).toContain("japanese");
  });

  run("catalog entries have correct kind from category field", () => {
    const result = service.listMedia({ limit: 50 });
    const thunder = result.items.find((item) => item.title === "Thunder");
    expect(thunder).toBeDefined();
    expect(thunder!.kind).toBe("ambience");

    const darling = result.items.find((item) => item.title === "Darling Dance");
    expect(darling).toBeDefined();
    expect(darling!.kind).toBe("song");
  });

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  run("filters by kind=song", () => {
    const result = service.listMedia({ kind: "song", limit: 50 });
    expect(result.items.length).toBeGreaterThanOrEqual(7);
    expect(result.items.every((item) => item.kind === "song")).toBe(true);
  });

  run("filters by kind=ambience", () => {
    const result = service.listMedia({ kind: "ambience", limit: 50 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.every((item) => item.kind === "ambience")).toBe(true);
  });

  run("filters by tag", () => {
    const result = service.listMedia({ tags: ["deco27"], limit: 50 });
    expect(result.items.length).toBe(2);
    const titles = result.items.map((item) => item.title).sort();
    expect(titles).toEqual(["Rabbit Hole", "Vampire"]);
  });

  run("query search finds tracks by title substring", () => {
    const result = service.listMedia({ query: "thunder", limit: 5 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]!.title).toBe("Thunder");
  });

  run("query search finds tracks by tag", () => {
    const result = service.listMedia({ query: "vocaloid", limit: 50 });
    expect(result.items.length).toBeGreaterThanOrEqual(7);
  });

  // -------------------------------------------------------------------------
  // Assistant context
  // -------------------------------------------------------------------------

  run("buildAssistantContext includes track counts", () => {
    const context = service.buildAssistantContext();
    expect(context).toContain("song");
    expect(context).toContain("ambience");
    expect(context).toMatch(/\d+ track/);
  });

  // -------------------------------------------------------------------------
  // No duplicate entries
  // -------------------------------------------------------------------------

  run("no duplicate entries from catalog + filesystem walk", () => {
    const result = service.listMedia({ limit: 50 });
    const paths = result.items.map((item) => item.path);
    const uniquePaths = new Set(paths);
    expect(paths.length).toBe(uniquePaths.size);
  });
});
