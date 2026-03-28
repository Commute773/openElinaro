import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

function parseOpenBrowserActionsInput(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch { return value; }
}

const openBrowserViewportSchema = z.object({
  width: z.number().int().min(200).max(4_000),
  height: z.number().int().min(200).max(4_000),
});

const openBrowserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url(), waitMs: z.number().int().min(0).max(15_000).optional() }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(15_000) }),
  z.object({ type: z.literal("mouse_move"), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000), steps: z.number().int().min(1).max(100).optional() }),
  z.object({ type: z.literal("mouse_click"), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000), button: z.enum(["left", "middle", "right"]).optional(), clickCount: z.number().int().min(1).max(3).optional() }),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("type"), text: z.union([z.string().max(10_000), z.object({ secretRef: z.string().min(1) })]), submit: z.boolean().optional(), delayMs: z.number().int().min(0).max(1_000).optional() }),
  z.object({ type: z.literal("evaluate"), expression: z.string().min(1), args: z.array(z.unknown()).max(8).optional(), captureResult: z.boolean().optional() }),
  z.object({ type: z.literal("screenshot"), path: z.string().min(1).optional(), format: z.enum(["png", "jpeg", "webp"]).optional(), quality: z.number().int().min(0).max(100).optional() }),
]);

const openBrowserSchema = z.object({
  startUrl: z.string().url().optional(),
  headless: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  cwd: z.string().optional(),
  artifactDir: z.string().optional(),
  sessionKey: z.string().min(1).optional(),
  resetSession: z.boolean().optional(),
  viewport: openBrowserViewportSchema.optional(),
  actions: z.preprocess(
    parseOpenBrowserActionsInput,
    z.array(openBrowserActionSchema).min(1).max(25),
  ),
});

export const buildSystemFunctions: FunctionDomainBuilder = (ctx) => [
  defineFunction({
    name: "openbrowser",
    description: "Run local browser automation with OpenBrowser. In an active agent thread, this reuses the same live browser session by default so later calls continue on the current page/tab unless resetSession is true. Occasionally inspect the page visually with screenshots so you confirm what the browser is actually showing, especially before or after important interactions. For user input, aggressively prefer real interaction: use coordinate-based mouse_click plus the dedicated type action instead of evaluate helpers that call element.click(), form.submit(), element.value=, or other DOM-mutation shortcuts. Treat DOM mutation as a fallback only when normal interaction fails, and verify field state with screenshots or explicit input.value checks rather than body.innerText alone. For stored credentials or cards, call secret_list first, then pass secret refs like { secretRef: \"prepaid_card.number\" } inside action args so the runtime resolves them server-side.",
    input: openBrowserSchema,
    handler: async (input, fnCtx) => fnCtx.services.openbrowser.run(input),
    auth: { access: "root", behavior: "uniform", note: "Launches a local browser session and may write screenshot artifacts to disk." },
    domains: ["browser", "automation"],
    agentScopes: ["chat", "direct"],
    examples: [
      "open page and screenshot",
      "reuse the current browser session and fill a form with { secretRef: \"prepaid_card.number\" }",
    ],
    featureGate: "openbrowser",
    mutatesState: true,
    untrustedOutput: {
      sourceType: "web",
      sourceName: "browser automation results",
      notes: "Page titles, JavaScript output, and screenshot paths come from external browser content.",
    },
  }),
];
