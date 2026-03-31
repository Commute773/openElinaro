import { chromium } from "playwright";

const htmlPath = new URL("../src/integrations/http/api/ui.html", import.meta.url).pathname;

// Mock OpenAPI spec
const spec = {
  openapi: "3.1.0",
  info: { title: "OpenElinaro API", version: "2.0.0" },
  paths: {
    "/api/routines/check": { get: { operationId: "routine_check", summary: "Check routines", tags: ["routines"] } },
    "/api/routines": { get: { operationId: "routine_list", summary: "List routines", tags: ["routines"], parameters: [
      { name: "kind", in: "query", schema: { type: "string" } },
    ] }, post: { operationId: "routine_add", summary: "Add routine", tags: ["routines"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, kind: { type: "string" } } } } } } } },
    "/api/routines/{id}/done": { post: { operationId: "routine_done", summary: "Mark done", tags: ["routines"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
    "/api/notifications": { get: { operationId: "api_notifications_list", summary: "Notifications", tags: ["notifications"] } },
    "/api/notifications/{id}/action": { post: { operationId: "api_notification_action", summary: "Notification action", tags: ["notifications"] } },
    "/api/agents": { get: { operationId: "api_agents_list", summary: "Agents", tags: ["agents"] } },
    "/api/agents/{id}/output": { get: { operationId: "api_agent_output", summary: "Agent output", tags: ["agents"] } },
    "/api/home": { get: { operationId: "api_home", summary: "Dashboard", tags: ["dashboard"] } },
    "/api/health": { get: { operationId: "api_health", summary: "Health", tags: ["dashboard"] } },
    "/api/projects": { get: { operationId: "api_projects", summary: "Projects", tags: ["dashboard"] } },
    "/api/finance/summary": { get: { operationId: "finance_summary", summary: "Finance summary", tags: ["finance"] } },
    "/api/chat/stream": { post: { operationId: "chat_stream", summary: "Streaming chat", tags: ["chat"] } },
  },
};

const mockData: Record<string, unknown> = {
  "/api/home": {
    timeContext: { dayOfWeek: "Sunday", localDate: "2026-03-29", localTime: "17:21", dayPeriod: "evening", timezone: "America/Montreal" },
    activeAgentCount: 1,
    pendingNotificationCount: 3,
    nextRoutine: { name: "Progesterone", time: "2026-03-30T03:00:00.000Z", type: "med" },
    agentFormat: "Sunday 17:21 evening\n3 notifications pending\n1 agents running\nNext: [med] Progesterone 23:00",
  },
  "/api/routines/check": {
    context: { mode: "personal" },
    actionableCount: 4,
    items: [
      { id: "med_estradiol", title: "Estradiol Valerate", kind: "med", priority: "high", state: "due", overdueMinutes: 1222, display: "[med!] Estradiol Valerate 6mg \u2014 20h 22m overdue" },
      { id: "med_retatrutide", title: "Retatrutide", kind: "med", priority: "high", state: "due", overdueMinutes: 1222, display: "[med!] Retatrutide 4mg \u2014 20h 22m overdue" },
      { id: "todo_cardio", title: "Figure out cardio routine", kind: "todo", priority: "medium", state: "backlog", overdueMinutes: 0, display: "[todo] Figure out cardio routine" },
      { id: "todo_reddit", title: "Add Reddit API integration", kind: "todo", priority: "low", state: "backlog", overdueMinutes: 0, display: "[todo] Add Reddit API integration" },
    ],
    agentFormat: "[med!] Estradiol Valerate 6mg \u2014 20h 22m overdue\n[med!] Retatrutide 4mg \u2014 20h 22m overdue\n[todo] Figure out cardio routine\n[todo] Add Reddit API integration",
  },
  "/api/notifications": {
    items: [
      { id: "routine:med_estradiol", type: "routine", title: "Estradiol Valerate", body: "med \u2014 1222m overdue", display: "Estradiol Valerate \u2014 med \u2014 1222m overdue" },
      { id: "routine:med_retatrutide", type: "routine", title: "Retatrutide", body: "med \u2014 1222m overdue", display: "Retatrutide \u2014 med \u2014 1222m overdue" },
      { id: "routine:todo_cardio", type: "routine", title: "Figure out cardio routine", body: "todo \u2014 due now", display: "Figure out cardio routine \u2014 todo \u2014 due now" },
    ],
    agentFormat: "Estradiol Valerate \u2014 med \u2014 1222m overdue\nRetatrutide \u2014 med \u2014 1222m overdue\nFigure out cardio routine \u2014 todo \u2014 due now",
  },
  "/api/agents": {
    items: [
      { id: "agt-1a2b", status: "RUNNING", host: "w1", uptime: "12m", goal_truncated: "Research Playwright testing patterns", display: "\u25CF agt-1a2b 12m Research Playwright testing patterns" },
    ],
    agentFormat: "\u25CF agt-1a2b 12m Research Playwright testing patterns",
  },
  "/api/health": {
    summary: { streak: 12, weeklyAvgMood: 7.2 },
    checkins: [],
    agentFormat: "streak: 12\nweekly avg mood: 7.2\ncheckins: []",
  },
  "/api/projects": {
    items: [
      { id: "openElinaro", name: "openElinaro", status: "active", priority: "high" },
      { id: "even-g2", name: "even-g2-app", status: "active", priority: "medium" },
    ],
    agentFormat: "openElinaro [active] \u2014 high\neven-g2-app [active] \u2014 medium",
  },
  "/api/finance/summary": {
    monthlyBudget: 2500, spent: 1847, remaining: 653, topCategory: "Software",
    agentFormat: "monthly budget: 2500\nspent: 1847\nremaining: 653\ntop category: Software",
  },
};

// Mock agent stream events for agent chat
const mockChatEvents = [
  { delay: 100, event: "thinking", data: { type: "thinking", text: "The user wants medication status. I should check the routines system for overdue med-type items..." } },
  { delay: 200, event: "tool_start", data: { type: "tool_start", name: "routine_check", args: { kind: "med" } } },
  { delay: 500, event: "tool_progress", data: { type: "tool_progress", name: "routine_check", elapsed: 1.2, message: "querying routines..." } },
  { delay: 400, event: "tool_end", data: { type: "tool_end", name: "routine_check", isError: false, summary: "2 medications found, both overdue" } },
  { delay: 100, event: "tool_summary", data: { type: "tool_summary", summary: "Estradiol Valerate (20h overdue), Retatrutide (20h overdue)" } },
  { delay: 200, event: "text", data: { type: "text", text: "You have two medications that are significantly overdue:" } },
  { delay: 50, event: "text", data: { type: "text", text: "1. Estradiol Valerate 6mg \u2014 20 hours overdue\n2. Retatrutide 4mg \u2014 20 hours overdue" } },
  { delay: 50, event: "text", data: { type: "text", text: "I recommend taking both as soon as possible. The Estradiol is particularly important to stay on schedule with." } },
  { delay: 100, event: "result", data: { type: "result", turns: 2, durationMs: 3200, costUsd: 0.0042 } },
];

function sseEvent(evt: string, data: unknown): string {
  return `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/g2" || url.pathname === "/") {
      return new Response(Bun.file(htmlPath), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/openapi.json") return Response.json(spec);
    if (url.pathname === "/api/events") return new Response("", { headers: { "Content-Type": "text/event-stream" } });

    // Streaming chat endpoint mock
    if (url.pathname === "/api/chat/stream" && req.method === "POST") {
      const stream = new ReadableStream<string>({
        async start(controller) {
          for (const entry of mockChatEvents) {
            await new Promise(r => setTimeout(r, entry.delay));
            controller.enqueue(sseEvent(entry.event, entry.data));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // Handle query params by matching base path
    const basePath = url.pathname.split("?")[0];
    const data = mockData[basePath] ?? mockData[url.pathname];
    if (data !== undefined) return Response.json(data);
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

const base = `http://localhost:${server.port}`;
console.log(`Serving at ${base}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

async function shot(name: string) {
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `/tmp/g2-${name}.png` });
  console.log(`\u2192 /tmp/g2-${name}.png`);
}

await page.goto(`${base}/g2`);
await shot("home");

// Cursor starts on first menu item (Agent Chat) — just press Enter
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
await shot("agent-chat-empty");

// Send a message via page.evaluate (simulates voice input)
await page.evaluate(() => {
  (window as any).sendChatMessage("What medications am I overdue on?");
});

// Wait for mock stream to complete
await page.waitForTimeout(3000);
await shot("agent-chat");

// Scroll up to see the top
for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
await shot("agent-chat-scrolled");

// Go back to home
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Navigate to Routines (1 down from current cursor on Agent Chat)
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await shot("routines");

// Go back — cursor is now on Routines (index 6)
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Navigate to Notifications (1 more down from Routines)
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await shot("notifications");

// Go back — cursor is now on Notifications (index 7)
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Navigate to Agents (1 more down from Notifications)
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await shot("agents");

// Go back to home, test line heights
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await page.locator("#lineHeight").selectOption("9");
await shot("home-lh9");
await page.locator("#lineHeight").selectOption("48");
await shot("home-lh48");

await browser.close();
server.stop();
