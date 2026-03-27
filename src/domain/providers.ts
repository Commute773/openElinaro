/**
 * Canonical provider identifier type.
 *
 * Every module that needs a provider-id union should import from here
 * so there is exactly one source of truth.
 */
export type ProviderId = "openai-codex" | "claude";
