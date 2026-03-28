/**
 * Reddit function definitions.
 * Uses the free unauthenticated Reddit JSON API (append .json to any URL).
 * No API key or OAuth required — just a custom User-Agent header.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const USER_AGENT = "OpenElinaro/1.0";
const BASE_URL = "https://www.reddit.com";

const REDDIT_AUTH = { access: "anyone" as const, behavior: "uniform" as const };
const REDDIT_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const REDDIT_DOMAINS = ["web", "social"];

const UNTRUSTED = {
  sourceType: "web",
  sourceName: "Reddit JSON API",
  notes: "All Reddit content is user-generated untrusted content.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function redditFetch(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Reddit API returned ${res.status} for ${url}`);
  }
  return res.json();
}

interface RedditPost {
  title: string;
  author: string;
  selftext: string;
  url: string;
  permalink: string;
  ups: number;
  num_comments: number;
  created_utc: number;
  subreddit: string;
  is_self: boolean;
  link_flair_text: string | null;
}

interface RedditComment {
  author: string;
  body: string;
  ups: number;
  created_utc: number;
}

function extractPosts(json: any): RedditPost[] {
  const children = json?.data?.children ?? [];
  return children
    .filter((c: any) => c.kind === "t3")
    .map((c: any) => {
      const d = c.data;
      return {
        title: d.title,
        author: d.author,
        selftext: d.selftext?.slice(0, 500) || "",
        url: d.url,
        permalink: `https://www.reddit.com${d.permalink}`,
        ups: d.ups,
        num_comments: d.num_comments,
        created_utc: d.created_utc,
        subreddit: d.subreddit,
        is_self: d.is_self,
        link_flair_text: d.link_flair_text,
      };
    });
}

function extractComments(json: any): RedditComment[] {
  const children = json?.data?.children ?? [];
  const comments: RedditComment[] = [];
  for (const c of children) {
    if (c.kind !== "t1") continue;
    const d = c.data;
    comments.push({
      author: d.author,
      body: d.body?.slice(0, 500) || "",
      ups: d.ups,
      created_utc: d.created_utc,
    });
  }
  return comments;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sortEnum = z.enum(["hot", "new", "top", "rising"]);
const timeEnum = z.enum(["hour", "day", "week", "month", "year", "all"]);

const subredditPostsSchema = z.object({
  subreddit: z.string().min(1).describe("Subreddit name without the r/ prefix"),
  sort: sortEnum.optional().describe("Sort order. Defaults to hot."),
  t: timeEnum.optional().describe("Time filter for top sort. Defaults to day."),
  limit: z.number().int().min(1).max(25).optional().describe("Number of posts to return. Defaults to 10."),
  after: z.string().optional().describe("Pagination cursor from a previous response."),
});

const redditSearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  subreddit: z.string().optional().describe("Restrict search to this subreddit (without r/ prefix). Omit for global search."),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional().describe("Sort order. Defaults to relevance."),
  t: timeEnum.optional().describe("Time filter. Defaults to all."),
  limit: z.number().int().min(1).max(25).optional().describe("Number of results. Defaults to 10."),
});

const postCommentsSchema = z.object({
  subreddit: z.string().min(1).describe("Subreddit name without the r/ prefix"),
  post_id: z.string().min(1).describe("The post ID (the alphanumeric string from the URL, e.g. 'abc123')"),
  limit: z.number().int().min(1).max(50).optional().describe("Number of top-level comments. Defaults to 10."),
});

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildRedditFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // reddit_posts
  // -----------------------------------------------------------------------
  defineFunction({
    name: "reddit_posts",
    description:
      "Fetch posts from a subreddit. Returns titles, authors, scores, comment counts, and links. Useful for monitoring communities, researching topics, or finding discussions.",
    input: subredditPostsSchema,
    handler: async (input) => {
      const sort = input.sort ?? "hot";
      const limit = input.limit ?? 10;
      const params = new URLSearchParams({ limit: String(limit) });
      if (sort === "top") params.set("t", input.t ?? "day");
      if (input.after) params.set("after", input.after);

      const json = await redditFetch(`/r/${input.subreddit}/${sort}.json?${params}`);
      const posts = extractPosts(json);
      const after = (json as any)?.data?.after ?? null;
      return { posts, after, subreddit: input.subreddit, sort };
    },
    auth: REDDIT_AUTH,
    domains: REDDIT_DOMAINS,
    agentScopes: REDDIT_SCOPES,
    examples: [
      "show me the hot posts on r/LocalLLaMA",
      "get top posts from r/homeassistant this week",
    ],
    untrustedOutput: UNTRUSTED,
  }),

  // -----------------------------------------------------------------------
  // reddit_search
  // -----------------------------------------------------------------------
  defineFunction({
    name: "reddit_search",
    description:
      "Search Reddit for posts matching a query, optionally restricted to a specific subreddit. Returns matching posts with titles, scores, and links.",
    input: redditSearchSchema,
    handler: async (input) => {
      const limit = input.limit ?? 10;
      const sort = input.sort ?? "relevance";
      const t = input.t ?? "all";

      const params = new URLSearchParams({
        q: input.query,
        sort,
        t,
        limit: String(limit),
      });

      let path: string;
      if (input.subreddit) {
        params.set("restrict_sr", "on");
        path = `/r/${input.subreddit}/search.json?${params}`;
      } else {
        path = `/search.json?${params}`;
      }

      const json = await redditFetch(path);
      const posts = extractPosts(json);
      const after = (json as any)?.data?.after ?? null;
      return { posts, after, query: input.query };
    },
    auth: REDDIT_AUTH,
    domains: REDDIT_DOMAINS,
    agentScopes: REDDIT_SCOPES,
    examples: [
      "search reddit for zigbee2mqtt setup guide",
      "search r/selfhosted for bun deploy",
    ],
    untrustedOutput: UNTRUSTED,
  }),

  // -----------------------------------------------------------------------
  // reddit_comments
  // -----------------------------------------------------------------------
  defineFunction({
    name: "reddit_comments",
    description:
      "Fetch the top-level comments on a Reddit post. Use this to read discussion threads and community opinions on a specific post.",
    input: postCommentsSchema,
    handler: async (input) => {
      const limit = input.limit ?? 10;
      const params = new URLSearchParams({ limit: String(limit) });
      const json = await redditFetch(
        `/r/${input.subreddit}/comments/${input.post_id}.json?${params}`,
      );
      // Reddit returns [post_listing, comments_listing]
      const arr = json as any[];
      const post = arr[0]?.data?.children?.[0]?.data;
      const comments = extractComments(arr[1] ?? {});
      return {
        post: post
          ? { title: post.title, author: post.author, selftext: post.selftext?.slice(0, 500) || "" }
          : null,
        comments,
      };
    },
    auth: REDDIT_AUTH,
    domains: REDDIT_DOMAINS,
    agentScopes: REDDIT_SCOPES,
    examples: [
      "read the comments on this reddit post",
      "what are people saying in r/LocalLLaMA about this",
    ],
    untrustedOutput: UNTRUSTED,
  }),
];
