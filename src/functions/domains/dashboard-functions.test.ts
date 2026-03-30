import { describe, expect, test } from "bun:test";
import { buildDashboardFunctions } from "./dashboard-functions";

describe("buildDashboardFunctions", () => {
  test("api_home omits the removed streak field", async () => {
    const fn = buildDashboardFunctions({} as never)[0];
    if (!fn) {
      throw new Error("Expected api_home function definition.");
    }

    const result = await fn.handler({}, {
      services: {
        routines: {
          assessNow: () => ({
            context: { mode: "personal" },
            items: [],
          }),
          listItems: () => [],
        },
        alarms: {
          listDueAlarms: () => [],
        },
      } as never,
    } as never) as Record<string, unknown>;

    expect(result).not.toHaveProperty("streak");
    expect(result.pendingNotificationCount).toBe(0);
  });
});
