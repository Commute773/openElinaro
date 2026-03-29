import { chromium } from "playwright";

const htmlPath = new URL("../src/integrations/http/g2/ui.html", import.meta.url).pathname;

// Mock OpenAPI spec that mirrors the real function catalogue
const mockOpenApiSpec = {
  openapi: "3.0.3",
  info: { title: "G2 API", version: "1.0.0" },
  paths: {
    "/home": {
      get: { operationId: "api_home", summary: "Dashboard", tags: ["dashboard"], parameters: [] },
    },
    "/health": {
      get: { operationId: "api_health", summary: "Health", tags: ["dashboard"], parameters: [
        { name: "limit", in: "query", schema: { type: "number", default: 5 } },
      ] },
    },
    "/agents": {
      get: { operationId: "api_agents_list", summary: "Agents", tags: ["agents"], parameters: [] },
    },
    "/agents/{id}/output": {
      get: { operationId: "api_agent_output", summary: "Agent output", tags: ["agents"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ] },
    },
    "/agents/{id}/summary": {
      get: { operationId: "api_agent_summary", summary: "Agent summary", tags: ["agents"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ] },
    },
    "/agents/{id}/send": {
      post: { operationId: "api_agent_send", summary: "Send to agent", tags: ["agents"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ], requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } } } },
    },
    "/notifications": {
      get: { operationId: "api_notifications_list", summary: "Notifications", tags: ["notifications"], parameters: [] },
    },
    "/notifications/{id}/action": {
      post: { operationId: "api_notification_action", summary: "Notification action", tags: ["notifications"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ], requestBody: { content: { "application/json": { schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } } } } },
    },
    "/routines": {
      get: { operationId: "api_routines_list", summary: "Routines", tags: ["routines"], parameters: [] },
    },
    "/routines/{id}/done": {
      post: { operationId: "api_routine_done", summary: "Complete routine", tags: ["routines"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ] },
    },
    "/todos": {
      get: { operationId: "api_todos_list", summary: "Todos", tags: ["routines"], parameters: [] },
    },
    "/todos/{id}/done": {
      post: { operationId: "api_todo_done", summary: "Complete todo", tags: ["routines"], parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ] },
    },
    "/projects": {
      get: { operationId: "api_projects", summary: "Projects", tags: ["dashboard"], parameters: [] },
    },
    "/conversations": {
      get: { operationId: "api_conversations", summary: "Conversations", tags: ["dashboard"], parameters: [] },
    },
    "/finance/summary": {
      get: { operationId: "api_finance_summary", summary: "Finance summary", tags: ["finance"], parameters: [] },
    },
    "/finance/budget": {
      get: { operationId: "api_finance_budget", summary: "Budget", tags: ["finance"], parameters: [] },
    },
  },
};

const mockData: Record<string, any> = {
  "/api/g2/home": {
    dayOfWeek: "Saturday",
    localDate: "2026-03-29",
    localTime: "15:42",
    dayPeriod: "afternoon",
    activeAgentCount: 2,
    pendingNotificationCount: 3,
    nextRoutine: "Review weekly finances and check budget status",
  },
  "/api/g2/health": {
    recentCheckins: [
      { date: "2026-03-29", mood: 8, energy: 7 },
      { date: "2026-03-28", mood: 6, energy: 5 },
    ],
    streak: 12,
    weeklyAvgMood: 7.2,
  },
  "/api/g2/agents": [
    { id: "agt-1a2b", status: "running", goal: "Research Playwright testing patterns for E2E coverage", uptime: "12m" },
    { id: "agt-3c4d", status: "running", goal: "Update deployment documentation", uptime: "3m" },
  ],
  "/api/g2/notifications": [
    { id: "n1", type: "routine", title: "Weekly review", body: "Time for your weekly project review" },
    { id: "n2", type: "alarm", title: "Stand up", body: "Daily standup in 5 minutes" },
    { id: "n3", type: "routine", title: "Finance check", body: "Monthly budget review due" },
  ],
  "/api/g2/routines": [
    { id: "r1", name: "Weekly review", schedule: "Sun 10:00", status: "pending" },
    { id: "r2", name: "Daily standup", schedule: "Mon-Fri 09:00", status: "done" },
    { id: "r3", name: "Finance check", schedule: "1st of month", status: "pending" },
  ],
  "/api/g2/todos": [
    { id: "t1", text: "Fix CORS headers on notification endpoint", status: "open" },
    { id: "t2", text: "Add pagination to agent output", status: "open" },
    { id: "t3", text: "Write E2E test for routine lifecycle", status: "done" },
  ],
  "/api/g2/projects": [
    { name: "openElinaro", status: "active", priority: "high" },
    { name: "even-g2-app", status: "active", priority: "medium" },
  ],
  "/api/g2/conversations": [
    { id: "c1", title: "G2 simulator UI", messageCount: 24 },
    { id: "c2", title: "Finance dashboard", messageCount: 8 },
  ],
  "/api/g2/finance/summary": {
    monthlyBudget: 2500,
    spent: 1847,
    remaining: 653,
    topCategory: "Software",
  },
  "/api/g2/finance/budget": {
    categories: [
      { name: "Software", budget: 800, spent: 650 },
      { name: "Food", budget: 600, spent: 520 },
      { name: "Transport", budget: 300, spent: 180 },
    ],
  },
};

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/g2" || url.pathname === "/g2/" || url.pathname === "/") {
      return new Response(Bun.file(htmlPath), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/api/g2/openapi.json") {
      return Response.json(mockOpenApiSpec);
    }
    if (url.pathname === "/api/g2/events") {
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    }
    // Serve mock data for any known path
    const data = mockData[url.pathname];
    if (data !== undefined) return Response.json(data);
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

const baseUrl = `http://localhost:${server.port}`;
console.log(`Serving at ${baseUrl}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

async function screenshot(name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/tmp/g2-${name}.png`, fullPage: false });
  console.log(`→ /tmp/g2-${name}.png`);
}

await page.goto(`${baseUrl}/g2`);
await screenshot("home");

// Switch to different screens via the dropdown
const screenSelect = page.locator('#screenSelect');
const options = await screenSelect.locator('option').allTextContents();
console.log('Available screens:', options);

for (const label of ['Agents', 'Notifications', 'Routines', 'Todos', 'Finance summary', 'Projects']) {
  try {
    await screenSelect.selectOption({ label });
    await screenshot(label.toLowerCase().replace(/ /g, '-'));
  } catch (e) {
    console.log(`  skip: ${label}`);
  }
}

// Test line heights
await screenSelect.selectOption({ label: 'Dashboard' });
await page.waitForTimeout(300);
for (const lh of ['9', '24', '48']) {
  await page.locator('#lineHeight').selectOption(lh);
  await screenshot(`lh${lh}`);
}

// Click a function in the sidebar to show detail panel
await page.locator('.fn-item').first().click();
await screenshot("fn-detail");

await browser.close();
server.stop();
