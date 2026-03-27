import { test, expect, describe } from "bun:test";
import { Zigbee2MqttService, detectZigbeeRadio } from "./zigbee2mqtt-service";

describe("Zigbee2MqttService", () => {
  test("starts in stopped state", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.isStarted()).toBe(false);
  });

  test("listDevices returns empty before start", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.listDevices()).toEqual([]);
  });

  test("renderStatus returns a string", async () => {
    const svc = new Zigbee2MqttService();
    const status = await svc.renderStatus();
    // May adopt a running bridge or report stopped — both are valid.
    expect(typeof status).toBe("string");
    expect(status).toContain("Zigbee bridge:");
  });

  test("stop is safe when not started", async () => {
    const svc = new Zigbee2MqttService();
    await svc.stop();
    expect(svc.isStarted()).toBe(false);
  });
});

describe("detectZigbeeRadio", () => {
  test("returns string or null", () => {
    const result = detectZigbeeRadio();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
