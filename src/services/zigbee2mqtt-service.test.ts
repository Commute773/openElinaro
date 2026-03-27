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

  test("getDevice returns undefined for unknown device", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.getDevice("nonexistent")).toBeUndefined();
  });

  test("getDeviceState returns undefined for unknown device", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.getDeviceState("nonexistent")).toBeUndefined();
  });

  test("renderStatus shows stopped state", () => {
    const svc = new Zigbee2MqttService();
    const status = svc.renderStatus();
    expect(status).toContain("Zigbee radio: stopped");
    expect(status).toContain("Devices: 0 paired");
    expect(status).toContain("No devices paired yet");
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
