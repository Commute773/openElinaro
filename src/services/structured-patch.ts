export type StructuredPatchOperation =
  | {
      type: "add";
      path: string;
      lines: string[];
    }
  | {
      type: "delete";
      path: string;
    }
  | {
      type: "update";
      path: string;
      moveTo?: string;
      chunks: StructuredPatchChunk[];
    };

export interface StructuredPatchChunk {
  oldLines: string[];
  newLines: string[];
}

function normalizePatchText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLines(text: string) {
  const lines = normalizePatchText(text).split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parsePathLine(line: string, prefix: string) {
  const value = line.slice(prefix.length).trim();
  if (!value) {
    throw new Error(`Missing path after ${prefix.trim()}`);
  }
  return value;
}

function parseUpdateChunks(lines: string[]) {
  const chunks: StructuredPatchChunk[] = [];
  let currentOld: string[] = [];
  let currentNew: string[] = [];
  let sawContent = false;

  const flush = () => {
    if (!sawContent) {
      return;
    }
    chunks.push({
      oldLines: currentOld,
      newLines: currentNew,
    });
    currentOld = [];
    currentNew = [];
    sawContent = false;
  };

  for (const line of lines) {
    if (line === "*** End of File") {
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      continue;
    }
    if (line.startsWith(" ")) {
      const value = line.slice(1);
      currentOld.push(value);
      currentNew.push(value);
      sawContent = true;
      continue;
    }
    if (line.startsWith("-")) {
      currentOld.push(line.slice(1));
      sawContent = true;
      continue;
    }
    if (line.startsWith("+")) {
      currentNew.push(line.slice(1));
      sawContent = true;
      continue;
    }
    throw new Error(`Unexpected update line: ${line}`);
  }

  flush();
  return chunks;
}

export function parseStructuredPatch(patchText: string): StructuredPatchOperation[] {
  const lines = splitLines(patchText);
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch");
  }
  if (lines.at(-1) !== "*** End Patch") {
    throw new Error("Patch must end with *** End Patch");
  }

  const operations: StructuredPatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("*** Add File: ")) {
      const filePath = parsePathLine(line, "*** Add File: ");
      index += 1;
      const addLines: string[] = [];
      while (index < lines.length - 1 && !lines[index]?.startsWith("*** ")) {
        const next = lines[index] ?? "";
        if (!next.startsWith("+")) {
          throw new Error(`Add file lines must start with +: ${next}`);
        }
        addLines.push(next.slice(1));
        index += 1;
      }
      operations.push({ type: "add", path: filePath, lines: addLines });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        type: "delete",
        path: parsePathLine(line, "*** Delete File: "),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = parsePathLine(line, "*** Update File: ");
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = parsePathLine(lines[index] ?? "", "*** Move to: ");
        index += 1;
      }
      const updateLines: string[] = [];
      while (index < lines.length - 1 && !lines[index]?.startsWith("*** ")) {
        updateLines.push(lines[index] ?? "");
        index += 1;
      }
      const chunks = parseUpdateChunks(updateLines);
      if (!moveTo && chunks.length === 0) {
        throw new Error(`Update for ${filePath} does not include any hunks.`);
      }
      operations.push({
        type: "update",
        path: filePath,
        moveTo,
        chunks,
      });
      continue;
    }

    throw new Error(`Unexpected patch header: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch rejected: no hunks found");
  }

  return operations;
}

function splitNormalizedContent(content: string) {
  const normalized = normalizePatchText(content);
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function findMatchIndex(haystack: string[], needle: string[], start: number) {
  if (needle.length === 0) {
    return Math.min(start, haystack.length);
  }
  for (let index = Math.max(0, start); index <= haystack.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}

export function applyStructuredUpdate(originalContent: string, chunks: StructuredPatchChunk[]) {
  const { lines: originalLines, trailingNewline } = splitNormalizedContent(originalContent);
  let lines = [...originalLines];
  let cursor = 0;

  for (const chunk of chunks) {
    const startIndex = findMatchIndex(lines, chunk.oldLines, cursor);
    if (startIndex === -1) {
      const preview = chunk.oldLines.slice(0, 4).join("\n");
      throw new Error(
        chunk.oldLines.length === 0
          ? "Patch hunk could not determine an insertion point."
          : `Patch hunk did not match the file contents.\nExpected:\n${preview}`,
      );
    }
    lines = [
      ...lines.slice(0, startIndex),
      ...chunk.newLines,
      ...lines.slice(startIndex + chunk.oldLines.length),
    ];
    cursor = startIndex + chunk.newLines.length;
  }

  let content = lines.join("\n");
  if (trailingNewline) {
    content += "\n";
  }
  return content;
}

export function buildAddedFileContent(lines: string[]) {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.join("\n")}\n`;
}
