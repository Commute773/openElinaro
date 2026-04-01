import fs from "node:fs";
import type { AppResponse, AppResponseAttachment } from "../domain/assistant";
import { DISCORD_MAX_ATTACHMENT_BYTES as MAX_DISCORD_ATTACHMENT_BYTES } from "../config/service-constants";
import { tryCatch } from "../utils/result";

const DISCORD_FILE_DIRECTIVE_PATTERN = /<discord-file\b([^>]*)\/?>/gi;
const DISCORD_FILE_ATTRIBUTE_PATTERN = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
export const ATTACHMENT_FAILED_PREFIX = "[ATTACHMENT FAILED]";
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
    const value = match[2] ?? match[3] ?? match[4] ?? "";
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
  const attachmentErrors: string[] = [...(params.response.attachmentErrors ?? [])];
  const attachments: AppResponseAttachment[] = [...(params.response.attachments ?? [])];

  const recordAttachmentFailure = (reason: string, failedPath: string) => {
    warnings.push(`${ATTACHMENT_FAILED_PREFIX} ${reason}`);
    attachmentErrors.push(failedPath);
  };

  for (const match of matches) {
    const attributes = parseDiscordFileDirectiveAttributes(match[1] ?? "");
    const rawPath = attributes.path?.trim();
    if (!rawPath) {
      warnings.push(`${ATTACHMENT_FAILED_PREFIX} A Discord file directive was ignored because it did not include a path.`);
      continue;
    }

    const attachResult = tryCatch(() => {
      const resolvedPath = params.assertPathAccess(rawPath);
      if (!fs.existsSync(resolvedPath)) {
        recordAttachmentFailure(`Discord file attachment was skipped because the file was not found: ${resolvedPath}`, resolvedPath);
        return;
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        recordAttachmentFailure(`Discord file attachment was skipped because the path is not a file: ${resolvedPath}`, resolvedPath);
        return;
      }

      if (stat.size > MAX_DISCORD_ATTACHMENT_BYTES) {
        recordAttachmentFailure(`Discord file attachment was skipped because it exceeds the ${MAX_DISCORD_ATTACHMENT_BYTES} byte limit: ${resolvedPath}`, resolvedPath);
        return;
      }

      attachments.push({
        path: resolvedPath,
        name: attributes.name?.trim() || undefined,
      });
    }, { operation: "discord.file_attachment", path: rawPath });
    if (!attachResult.ok) {
      recordAttachmentFailure(`Discord file attachment was skipped: ${attachResult.error.message}`, rawPath);
    }
  }

  const cleanedMessage = sanitizeDiscordText(params.response.message);
  return {
    ...params.response,
    message: cleanedMessage || (attachments.length > 0 ? "Attached file." : params.response.message),
    warnings: warnings.map((warning) => sanitizeDiscordText(warning)),
    attachmentErrors: attachmentErrors.length > 0 ? attachmentErrors : undefined,
    attachments,
  };
}
