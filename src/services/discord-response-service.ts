import fs from "node:fs";
import type { AppResponse, AppResponseAttachment } from "../domain/assistant";
import { DISCORD_MAX_ATTACHMENT_BYTES as MAX_DISCORD_ATTACHMENT_BYTES } from "../config/service-constants";

const DISCORD_FILE_DIRECTIVE_PATTERN = /<discord-file\b([^>]*)\/?>/gi;
const DISCORD_FILE_ATTRIBUTE_PATTERN = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
const UNTRUSTED_CONTENT_WARNING_LINE = "UNTRUSTED CONTENT WARNING";
const UNTRUSTED_DATA_BEGIN_LINE = "BEGIN_UNTRUSTED_DATA";
const UNTRUSTED_DATA_END_LINE = "END_UNTRUSTED_DATA";

type DiscordFileDirective = {
  path?: string;
  name?: string;
};

function parseDiscordFileDirectiveAttributes(rawAttributes: string): DiscordFileDirective {
  const parsed: DiscordFileDirective = {};
  for (const match of rawAttributes.matchAll(DISCORD_FILE_ATTRIBUTE_PATTERN)) {
    const key = match[1]?.trim().toLowerCase();
    const value = match[2] ?? match[3] ?? "";
    if (!key) {
      continue;
    }

    if (key === "path" || key === "name") {
      parsed[key] = value;
    }
  }
  return parsed;
}

function stripDiscordFileDirectives(text: string) {
  return text
    .replace(DISCORD_FILE_DIRECTIVE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripUntrustedFormatting(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cleaned: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== UNTRUSTED_CONTENT_WARNING_LINE) {
      cleaned.push(lines[index] ?? "");
      continue;
    }

    let beginIndex = -1;
    let endIndex = -1;

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor] === UNTRUSTED_DATA_BEGIN_LINE) {
        beginIndex = cursor;
        break;
      }
    }

    if (beginIndex >= 0) {
      for (let cursor = beginIndex + 1; cursor < lines.length; cursor += 1) {
        if (lines[cursor] === UNTRUSTED_DATA_END_LINE) {
          endIndex = cursor;
          break;
        }
      }
    }

    if (beginIndex < 0 || endIndex < 0) {
      cleaned.push(lines[index] ?? "");
      continue;
    }

    cleaned.push(
      ...lines
        .slice(beginIndex + 1, endIndex)
        .map((line) => (line.startsWith("| ") ? line.slice(2) : line === "|" ? "" : line)),
    );
    index = endIndex;
  }

  return cleaned.join("\n");
}

export function sanitizeDiscordText(text: string) {
  return stripDiscordFileDirectives(stripUntrustedFormatting(text));
}

export function resolveDiscordResponse(params: {
  response: AppResponse;
  assertPathAccess: (targetPath: string) => string;
}): AppResponse {
  const matches = [...params.response.message.matchAll(DISCORD_FILE_DIRECTIVE_PATTERN)];
  const warnings = [...(params.response.warnings ?? [])];
  const attachments: AppResponseAttachment[] = [...(params.response.attachments ?? [])];

  for (const match of matches) {
    const attributes = parseDiscordFileDirectiveAttributes(match[1] ?? "");
    if (!attributes.path?.trim()) {
      warnings.push("A Discord file directive was ignored because it did not include a path.");
      continue;
    }

    try {
      const resolvedPath = params.assertPathAccess(attributes.path);
      if (!fs.existsSync(resolvedPath)) {
        warnings.push(`Discord file attachment was skipped because the file was not found: ${resolvedPath}`);
        continue;
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        warnings.push(`Discord file attachment was skipped because the path is not a file: ${resolvedPath}`);
        continue;
      }

      if (stat.size > MAX_DISCORD_ATTACHMENT_BYTES) {
        warnings.push(
          `Discord file attachment was skipped because it exceeds the ${MAX_DISCORD_ATTACHMENT_BYTES} byte limit: ${resolvedPath}`,
        );
        continue;
      }

      attachments.push({
        path: resolvedPath,
        name: attributes.name?.trim() || undefined,
      });
    } catch (error) {
      warnings.push(
        `Discord file attachment was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const cleanedMessage = sanitizeDiscordText(params.response.message);
  return {
    ...params.response,
    message: cleanedMessage || (attachments.length > 0 ? "Attached file." : params.response.message),
    warnings: warnings.map((warning) => sanitizeDiscordText(warning)),
    attachments,
  };
}
