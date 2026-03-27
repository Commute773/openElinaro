import { test, expect, describe } from "bun:test";
import { Zigbee2MqttService } from "./zigbee2mqtt-service";

describe("Zigbee2MqttService", () => {
  test("starts disconnected with offline bridge", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.isConnected()).toBe(false);
    expect(svc.getBridgeState()).toBe("offline");
  });

  test("listDevices returns empty before connect", () => {
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

  test("renderStatus shows disconnected state", () => {
    const svc = new Zigbee2MqttService();
    const status = svc.renderStatus();
    expect(status).toContain("Bridge: offline");
    expect(status).toContain("MQTT: disconnected");
    expect(status).toContain("No devices paired yet");
  });

  test("renderDeviceDetail returns not found for unknown device", () => {
    const svc = new Zigbee2MqttService();
    expect(svc.renderDeviceDetail("ghost")).toContain('not found');
  });

  test("disconnect is safe when not connected", async () => {
    const svc = new Zigbee2MqttService();
    await svc.disconnect(); // Should not throw.
    expect(svc.isConnected()).toBe(false);
  });
});
