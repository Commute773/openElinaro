/**
 * Media catalog: file discovery, classification, scoring, and library building.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "../runtime-root";
import { AMBIENCE_HINTS, SUPPORTED_MEDIA_EXTENSIONS, getDefaultMediaRoots } from "./constants";
import type { MediaCatalogFile, MediaItem, MediaKind } from "./types";
import { normalizeToken, readJsonFile, slugify, titleCaseFromSlug, uniqueStrings } from "./utils";

export function getLibrary(mediaRoots: string[], catalogPath: string): MediaItem[] {
  const catalogEntries = getCatalogEntries(catalogPath, mediaRoots);
  const library = new Map<string, MediaItem>();
  const seenPaths = new Set<string>();

  for (const entry of catalogEntries) {
    library.set(entry.id, entry);
    seenPaths.add(entry.path);
  }

  for (const root of mediaRoots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const filePath of walkMediaFiles(root)) {
      const resolved = path.resolve(filePath);
      if (seenPaths.has(resolved)) {
        continue;
      }
      const item = buildSyntheticMediaItem(resolved, root);
      seenPaths.add(item.path);
      library.set(item.id, item);
    }
  }

  return [...library.values()].sort((left, right) => left.title.localeCompare(right.title));
}

export function getCatalogEntries(catalogPath: string, mediaRoots: string[]): MediaItem[] {
  const catalog = readJsonFile<MediaCatalogFile>(catalogPath);
  if (!catalog?.tracks?.length) {
    return [];
  }
  const catalogRoot = mediaRoots[0]
    ?? getDefaultMediaRoots()[0]
    ?? resolveRuntimePath("media");
  const items: MediaItem[] = [];

  for (const track of catalog.tracks) {
    if (!track.file?.trim()) {
      continue;
    }
    const trackFile = track.file.trim();
    const absolutePath = path.resolve(catalogRoot, trackFile);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
      continue;
    }
    const tags = buildTags(track.tags ?? [], absolutePath, inferKind(track.category, track.tags, absolutePath));
    const kind = inferKind(track.category, tags, absolutePath);
    items.push({
      id: slugify(track.id?.trim() || track.title?.trim() || track.file),
      title: track.title?.trim() || titleCaseFromSlug(path.basename(trackFile)),
      path: absolutePath,
      relativePath: trackFile,
      kind,
      tags,
      source: "local",
      artist: track.artist?.trim() || undefined,
    });
  }

  return items;
}

export function walkMediaFiles(root: string): string[] {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) {
      continue;
    }
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      files.push(target);
    }
  }
  return files;
}

export function buildSyntheticMediaItem(filePath: string, root: string): MediaItem {
  const relativePath = path.relative(root, filePath);
  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  const title = titleCaseFromSlug(path.basename(filePath));
  const kind = inferKind(undefined, [], filePath);
  const tags = buildTags([], filePath, kind);
  const isPrimaryThunderTrack = kind === "ambience" && normalizedRelativePath === "ambience/thunder.mp3";
  const baseId = isPrimaryThunderTrack
    ? "thunder-noises"
    : slugify(relativePath);
  return {
    id: baseId,
    title: isPrimaryThunderTrack ? "Thunder Noises" : title,
    path: filePath,
    relativePath,
    kind,
    tags,
    source: "local",
  };
}

export function buildTags(inputTags: string[], filePath: string, kind: MediaKind) {
  const relativeTokens = path.relative(path.dirname(filePath), filePath)
    .split(/[\/_.\-\s]+/g)
    .map(normalizeToken)
    .filter(Boolean);
  const baseTags = [...inputTags.map(normalizeToken), ...relativeTokens];
  if (kind === "ambience") {
    baseTags.push("ambient", "ambience", "background");
  } else {
    baseTags.push("song", "songs", "music");
  }
  if (filePath.toLowerCase().includes("thunder")) {
    baseTags.push("storm", "rain", "sleep", "thunder");
  }
  return uniqueStrings(baseTags);
}

export function inferKind(category: string | undefined, tags: string[] | undefined, filePath: string): MediaKind {
  const categoryToken = normalizeToken(category ?? "");
  if (["ambient", "ambience", "ambient-noise", "ambient_noise", "ambient-sound", "ambient_sound"].includes(categoryToken)) {
    return "ambience";
  }
  if (["song", "songs", "music", "track", "tracks"].includes(categoryToken)) {
    return "song";
  }
  const tokens = [
    ...((tags ?? []).map(normalizeToken)),
    ...filePath.split(/[\/_.\-\s]+/g).map(normalizeToken),
  ];
  return tokens.some((token) => AMBIENCE_HINTS.has(token)) ? "ambience" : "song";
}

export function filterLibrary(
  library: MediaItem[],
  options?: {
    query?: string;
    kind?: MediaKind | "all";
    tags?: string[];
    limit?: number;
  },
) {
  const requestedTags = (options?.tags ?? []).map(normalizeToken);
  const query = options?.query?.trim().toLowerCase();
  return library
    .filter((item) => !options?.kind || options.kind === "all" || item.kind === options.kind)
    .filter((item) => requestedTags.every((tag) => item.tags.includes(tag)))
    .map((item) => ({
      item,
      score: query ? scoreMediaItem(item, query) : 0,
    }))
    .filter((entry) => !query || entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.item.title.localeCompare(right.item.title)
    )
    .map((entry) => entry.item);
}

export function scoreMediaItem(item: MediaItem, query: string) {
  const normalizedQuery = normalizeToken(query);
  const queryTokens = normalizedQuery.split(/\s+/g).filter(Boolean);
  let score = 0;

  if (item.id === normalizedQuery) {
    score += 400;
  }
  if (item.title.toLowerCase() === normalizedQuery) {
    score += 320;
  }
  if (item.path.toLowerCase() === normalizedQuery) {
    score += 300;
  }
  if (item.tags.includes(normalizedQuery)) {
    score += 280;
  }
  if (item.title.toLowerCase().includes(normalizedQuery)) {
    score += 160;
  }
  if (item.relativePath.toLowerCase().includes(normalizedQuery)) {
    score += 140;
  }
  for (const token of queryTokens) {
    if (item.tags.includes(token)) {
      score += 60;
    }
    if (item.title.toLowerCase().includes(token)) {
      score += 35;
    }
    if (item.relativePath.toLowerCase().includes(token)) {
      score += 25;
    }
  }
  if (item.kind === "ambience" && queryTokens.some((token) => token === "ambient" || token === "ambience")) {
    score += 40;
  }
  if (item.kind === "song" && queryTokens.some((token) => token === "song" || token === "music")) {
    score += 40;
  }
  return score;
}

export function resolveMediaItem(query: string, kind: MediaKind | undefined, mediaRoots: string[], catalogPath: string) {
  const directPath = query.startsWith("/") ? path.resolve(query) : "";
  if (directPath && existsSync(directPath) && SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(directPath).toLowerCase())) {
    return buildSyntheticMediaItem(directPath, path.dirname(directPath));
  }

  const matches = filterLibrary(getLibrary(mediaRoots, catalogPath), {
    query,
    kind: kind ?? "all",
    limit: 10,
  });
  if (matches.length === 0) {
    throw new Error(`No media matched "${query}".`);
  }
  const item = matches[0];
  if (!item) {
    throw new Error(`No media matched "${query}".`);
  }
  return item;
}

export function resolveMediaForPath(mediaPath: string | undefined, mediaRoots: string[], catalogPath: string) {
  const normalizedPath = mediaPath?.trim();
  if (!normalizedPath) {
    return null;
  }
  return getLibrary(mediaRoots, catalogPath).find((item) => item.path === path.resolve(normalizedPath))
    ?? buildSyntheticMediaItem(path.resolve(normalizedPath), path.dirname(path.resolve(normalizedPath)));
}
