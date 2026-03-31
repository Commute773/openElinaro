import { test, expect, describe } from "bun:test";
import { buildAuthEnv } from "./claude-sdk-core";

describe("buildAuthEnv", () => {
  test("routes OAuth setup tokens to CLAUDE_CODE_OAUTH_TOKEN", () => {
    const env = buildAuthEnv("sk-ant-oat01-abc123-long-token-value");
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc123-long-token-value" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("routes standard API keys to ANTHROPIC_API_KEY", () => {
    const env = buildAuthEnv("sk-ant-api03-abc123");
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-abc123" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("routes non-anthropic keys to ANTHROPIC_API_KEY", () => {
    const env = buildAuthEnv("some-other-api-key");
    expect(env).toEqual({ ANTHROPIC_API_KEY: "some-other-api-key" });
  });
});
