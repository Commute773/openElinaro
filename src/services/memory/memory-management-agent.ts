import type { ProfileRecord } from "../../domain/profiles";
import type { ModelService } from "../models/model-service";
import { StructuredMemoryManager, MEMORY_CATEGORIES, type MemoryCategory } from "./structured-memory-manager";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { attempt, attemptAsync } from "../../utils/result";

const agentTelemetry = telemetry.child({ component: "memory_management_agent" });
const traceSpan = createTraceSpan(agentTelemetry);

/**
 * Structured entity extracted by the LLM from a conversation.
 */
type ExtractedEntity = {
  category: MemoryCategory;
  title: string;
  slug: string;
  facts: string[];
};

type ExtractionResult = {
  entities: ExtractedEntity[];
};

function buildExtractionSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return [
    "You are a structured memory extraction agent.",
    "You receive a conversation transcript (or compaction summary) and extract durable, structured entities from it.",
    "",
    `Today's date is ${today}.`,
    "",
    "Extract entities into these categories:",
    "- **people**: individuals mentioned by name — who they are, their role, relationship to the user, preferences, notable facts",
    "- **projects**: named projects, repos, or initiatives — their purpose, status, tech stack, key decisions",
    "- **topics**: recurring themes, domains, or areas of interest — what the user cares about, key insights",
    "- **decisions**: significant choices or architectural decisions — what was decided, why, alternatives considered",
    "- **preferences**: user preferences, workflow habits, tool choices — how they like to work",
    "- **tools**: specific tools, services, or technologies — how they're used, configuration, gotchas",
    "- **incidents**: bugs, outages, or problems encountered — what happened, root cause, resolution",
    "",
    "Rules:",
    "- Only extract entities that contain durable, reusable information — skip transient chatter",
    "- For each entity, provide a clear title (display name) and a list of factual bullet points",
    "- Use the person's actual name as the title for people entries",
    "- If an entity was mentioned briefly without meaningful detail, skip it",
    "- Prefer updating existing entities over creating new duplicates",
    `- Tag each fact with the date it was observed: append [${today}] at the end of each fact`,
    '  Example: "Started using Tailscale for VPN access [2026-03-15]"',
    "- Return strict JSON matching the schema below",
    "",
    "Schema:",
    "```json",
    '{',
    '  "entities": [',
    '    {',
    '      "category": "people|projects|topics|decisions|preferences|tools|incidents",',
    '      "title": "Display Name",',
    '      "slug": "lowercase-kebab-case-identifier",',
    '      "facts": ["fact 1 [2026-03-29]", "fact 2 [2026-03-29]"]',
    '    }',
    '  ]',
    '}',
    "```",
    "",
    "If nothing is worth extracting, return: { \"entities\": [] }",
  ].join("\n");
}

const MERGE_SYSTEM_PROMPT = [
  "You are a structured memory merge agent.",
  "You receive an existing memory document and new facts to incorporate.",
  "Merge the new facts into the existing document, following these rules:",
  "",
  "- Preserve all existing facts that are still accurate",
  "- Add new facts that aren't already covered",
  "- Update facts that have changed (prefer the newer information)",
  "- Remove facts that are explicitly contradicted by new information",
  "- Keep the document well-organized with clear bullet points",
  "- Do not add section headings unless the document is very long (20+ bullets)",
  "- Be concise — each bullet should be one clear fact",
  "- Preserve date tags like [2026-03-29] on facts — when updating a fact, use the newer date",
  "- Facts without date tags are legacy; if you're touching them, add today's date tag",
  "- Do not include frontmatter — just return the body content",
  "",
  "Return only the merged markdown body content, nothing else.",
].join("\n");

function stripCodeFence(text: string) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseExtractionResponse(raw: string): ExtractionResult {
  const cleaned = stripCodeFence(raw);
  const firstAttempt = attempt(() => {
    const parsed = JSON.parse(cleaned) as ExtractionResult;
    if (!Array.isArray(parsed.entities)) {
      return { entities: [] };
    }
    return {
      entities: parsed.entities.filter(
        (e) =>
          MEMORY_CATEGORIES.includes(e.category as MemoryCategory) &&
          typeof e.title === "string" &&
          e.title.trim() &&
          typeof e.slug === "string" &&
          e.slug.trim() &&
          Array.isArray(e.facts) &&
          e.facts.length > 0,
      ),
    };
  });
  if (firstAttempt.ok) return firstAttempt.value;

  // Try to find JSON object in the response
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const fallback = attempt(() => {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as ExtractionResult;
      if (Array.isArray(parsed.entities)) {
        return {
          entities: parsed.entities.filter(
            (e) =>
              MEMORY_CATEGORIES.includes(e.category as MemoryCategory) &&
              typeof e.title === "string" &&
              e.title.trim(),
          ),
        };
      }
      return null;
    });
    if (fallback.ok && fallback.value) return fallback.value;
  }
  return { entities: [] };
}

export class MemoryManagementAgent {
  constructor(
    private readonly structuredMemory: StructuredMemoryManager,
    private readonly models: Pick<ModelService, "generateMemoryText">,
  ) {}

  /**
   * Process a conversation transcript or compaction summary and update
   * structured memory files. This is the main entry point called after
   * compaction or at the end of a chat session.
   *
   * Runs entirely in the background — failures are logged but never
   * propagated to the caller.
   */
  async processTranscript(params: {
    transcript: string;
    conversationKey: string;
    source: "compaction" | "session_end";
  }): Promise<{ updatedEntries: number; newEntries: number }> {
    return traceSpan(
      "memory_management_agent.process",
      async () => {
        // Step 1: Extract entities from the transcript
        const extraction = await this.extractEntities(params.transcript);
        if (extraction.entities.length === 0) {
          agentTelemetry.event("memory_management_agent.no_entities", {
            conversationKey: params.conversationKey,
            source: params.source,
            transcriptLength: params.transcript.length,
          });
          return { updatedEntries: 0, newEntries: 0 };
        }

        // Step 2: For each entity, check if it exists and merge or create
        let updatedEntries = 0;
        let newEntries = 0;

        for (const entity of extraction.entities) {
          const result = await attemptAsync(async () => {
            const existing = await this.structuredMemory.readEntry(
              entity.category,
              entity.slug,
            );

            if (existing) {
              // Merge new facts into existing entry
              const mergedContent = await this.mergeEntityContent({
                existingBody: existing.body,
                newFacts: entity.facts,
                title: entity.title,
                category: entity.category,
              });

              await this.structuredMemory.upsertEntry({
                category: entity.category,
                slug: entity.slug,
                title: existing.title || entity.title,
                content: mergedContent,
              });
              updatedEntries += 1;
            } else {
              // Create new entry
              const content = entity.facts.map((f) => `- ${f}`).join("\n");
              await this.structuredMemory.upsertEntry({
                category: entity.category,
                slug: entity.slug,
                title: entity.title,
                content,
              });
              newEntries += 1;
            }
          });
          if (!result.ok) {
            agentTelemetry.event(
              "memory_management_agent.entity_upsert_failed",
              {
                category: entity.category,
                slug: entity.slug,
                error: result.error.message,
              },
              { level: "warn", outcome: "error" },
            );
          }
        }

        agentTelemetry.event("memory_management_agent.process_completed", {
          conversationKey: params.conversationKey,
          source: params.source,
          extractedEntities: extraction.entities.length,
          updatedEntries,
          newEntries,
        });

        return { updatedEntries, newEntries };
      },
      {
        attributes: {
          conversationKey: params.conversationKey,
          source: params.source,
          transcriptLength: params.transcript.length,
        },
      },
    );
  }

  /**
   * Extract structured entities from a transcript using the LLM.
   */
  private async extractEntities(transcript: string): Promise<ExtractionResult> {
    return traceSpan(
      "memory_management_agent.extract",
      async () => {
        // Build context about what entries already exist so the LLM can
        // reference existing slugs and avoid duplicates
        const existingContext = await this.buildExistingEntriesContext();

        const userPrompt = [
          existingContext
            ? `Existing structured memory entries (use these slugs when updating):\n${existingContext}\n\n`
            : "",
          "Conversation transcript to extract from:\n\n",
          transcript,
        ].join("");

        const response = await this.models.generateMemoryText({
          systemPrompt: buildExtractionSystemPrompt(),
          userPrompt,
          usagePurpose: "structured_memory_extraction",
          sessionIdPrefix: "structured-memory",
        });

        return parseExtractionResponse(response);
      },
      {
        attributes: {
          transcriptLength: transcript.length,
        },
      },
    );
  }

  /**
   * Merge new facts into an existing memory entry body using the LLM.
   */
  private async mergeEntityContent(params: {
    existingBody: string;
    newFacts: string[];
    title: string;
    category: MemoryCategory;
  }): Promise<string> {
    return traceSpan(
      "memory_management_agent.merge",
      async () => {
        const newFactsList = params.newFacts.map((f) => `- ${f}`).join("\n");

        const userPrompt = [
          `Entry: ${params.title} (${params.category})`,
          "",
          "Existing content:",
          params.existingBody,
          "",
          "New facts to merge:",
          newFactsList,
        ].join("\n");

        const response = await this.models.generateMemoryText({
          systemPrompt: MERGE_SYSTEM_PROMPT,
          userPrompt,
          usagePurpose: "structured_memory_merge",
          sessionIdPrefix: "structured-memory-merge",
        });

        // If the response is empty or trivially short, fall back to appending
        const cleaned = stripCodeFence(response).trim();
        if (cleaned.length < 10) {
          return [params.existingBody, "", newFactsList].join("\n").trim();
        }

        return cleaned;
      },
      {
        attributes: {
          title: params.title,
          category: params.category,
          existingBodyLength: params.existingBody.length,
          newFactsCount: params.newFacts.length,
        },
      },
    );
  }

  /**
   * Build a summary of existing entries for the extraction prompt.
   */
  private async buildExistingEntriesContext(): Promise<string> {
    const lines: string[] = [];
    for (const category of MEMORY_CATEGORIES) {
      const entries = await this.structuredMemory.listCategory(category);
      if (entries.length === 0) continue;
      lines.push(`${category}: ${entries.map((e) => `${e.title} (${e.slug})`).join(", ")}`);
    }
    return lines.join("\n");
  }
}
