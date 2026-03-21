import { afterEach, describe, expect, mock, test } from "bun:test";
import { WebSearchService } from "./web-search-service";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("WebSearchService", () => {
  test("defaults Brave searches to English language and UI locale", async () => {
    let requestedUrl = "";
    globalThis.fetch = mock(async (input: unknown) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: "Example",
              url: "https://example.com",
              description: "Stub result",
            },
          ],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const service = new WebSearchService("test-api-key");
    const result = await service.searchBrave({ query: "time blindness patch" });

    const url = new URL(requestedUrl);
    expect(url.searchParams.get("q")).toBe("time blindness patch");
    expect(url.searchParams.get("search_lang")).toBe("en");
    expect(url.searchParams.get("ui_lang")).toBe("en-US");
    expect(result.count).toBe(1);
    expect(result.results[0]?.url).toBe("https://example.com");
  });
});
