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

  test("renderStatus shows stopped state", async () => {
    const svc = new Zigbee2MqttService();
    const status = await svc.renderStatus();
    expect(status).toContain("Zigbee bridge: stopped");
    expect(status).toContain("bridge not running");
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
