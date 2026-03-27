#!/usr/bin/env node
/**
 * Zigbee bridge sidecar — runs zigbee-herdsman in Node.js and exposes an HTTP API.
 * Required because Bun doesn't support the libuv functions that serialport needs.
 *
 * Usage: node scripts/zigbee-bridge.mjs --port 8085 --serial /dev/cu.usbserial-120 --adapter ember --channel 11 --db-path ~/.openelinaro/zigbee
 */

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Controller } from "zigbee-herdsman";
import { findByDevice } from "zigbee-herdsman-converters";

// ---------- Args ----------

const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HTTP_PORT = parseInt(arg("port", "8085"), 10);
const SERIAL_PORT = arg("serial", "");
const ADAPTER_TYPE = arg("adapter", "ember");
const CHANNEL = parseInt(arg("channel", "11"), 10);
const DB_DIR = arg("db-path", path.join(process.env.HOME || "/tmp", ".openelinaro", "zigbee"));

if (!SERIAL_PORT) {
  console.error("--serial is required");
  process.exit(1);
}

// ---------- State ----------

let controller = null;
let started = false;
const friendlyNames = {};
const deviceStates = {};
const definitionCache = {};

// ---------- Friendly names ----------

const namesPath = path.join(DB_DIR, "friendly_names.json");

function loadNames() {
  try {
    Object.assign(friendlyNames, JSON.parse(fs.readFileSync(namesPath, "utf8")));
  } catch {}
}

function saveNames() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(namesPath, JSON.stringify(friendlyNames, null, 2));
}

function ensureName(device) {
  if (friendlyNames[device.ieeeAddr]) return;
  const base = device.modelID
    ? `${device.manufacturerName || "unknown"}_${device.modelID}`.replace(/[^a-zA-Z0-9_-]/g, "_")
    : device.ieeeAddr;
  let name = base;
  const existing = new Set(Object.values(friendlyNames));
  let i = 2;
  while (existing.has(name)) name = `${base}_${i++}`;
  friendlyNames[device.ieeeAddr] = name;
}

function getName(device) {
  return friendlyNames[device.ieeeAddr] || device.ieeeAddr;
}

function resolveDevice(nameOrAddr) {
  if (!controller) return null;
  const byAddr = controller.getDeviceByIeeeAddr(nameOrAddr);
  if (byAddr) return byAddr;
  const ieee = Object.entries(friendlyNames).find(([, n]) => n === nameOrAddr)?.[0];
  if (ieee) return controller.getDeviceByIeeeAddr(ieee);
  return null;
}

// ---------- Definition cache ----------

async function resolveDef(device) {
  if (definitionCache[device.ieeeAddr] !== undefined) return definitionCache[device.ieeeAddr];
  try {
    const def = (await findByDevice(device, true)) || null;
    definitionCache[device.ieeeAddr] = def;
    return def;
  } catch {
    definitionCache[device.ieeeAddr] = null;
    return null;
  }
}

// ---------- Controller ----------

async function startController() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  loadNames();

  controller = new Controller({
    network: { panID: 0x1a62, channelList: [CHANNEL] },
    serialPort: { path: SERIAL_PORT, adapter: ADAPTER_TYPE },
    databasePath: path.join(DB_DIR, "database.db"),
    databaseBackupPath: path.join(DB_DIR, "database.db.backup"),
    backupPath: path.join(DB_DIR, "coordinator_backup.json"),
    adapter: { concurrent: 16, disableLED: false },
    acceptJoiningDeviceHandler: async () => true,
  });

  controller.on("message", (data) => {
    const name = getName(data.device);
    if (data.type === "attributeReport" || data.type === "readResponse") {
      const existing = deviceStates[name] || {};
      const update = typeof data.data === "object" && !Buffer.isBuffer(data.data) && !Array.isArray(data.data) ? data.data : {};
      deviceStates[name] = { ...existing, ...update, linkquality: data.linkquality };
    }
  });

  controller.on("deviceJoined", (data) => {
    ensureName(data.device);
    saveNames();
    console.log(`Device joined: ${data.device.ieeeAddr} → ${getName(data.device)}`);
  });

  controller.on("deviceInterview", async (data) => {
    if (data.status === "successful") {
      await resolveDef(data.device);
      ensureName(data.device);
      saveNames();
      console.log(`Interview complete: ${getName(data.device)} (${data.device.modelID})`);
    }
  });

  controller.on("deviceLeave", (data) => {
    console.log(`Device left: ${data.ieeeAddr}`);
  });

  await controller.start();
  started = true;
  console.log(`Zigbee controller started on ${SERIAL_PORT} (adapter=${ADAPTER_TYPE}, channel=${CHANNEL})`);

  for (const device of controller.getDevices()) {
    if (device.type !== "Coordinator") {
      void resolveDef(device);
      ensureName(device);
    }
  }
  saveNames();
}

// ---------- Device info builder ----------

function buildDeviceInfo(device) {
  const def = definitionCache[device.ieeeAddr] || null;
  return {
    ieeeAddr: device.ieeeAddr,
    friendlyName: getName(device),
    type: device.type,
    modelID: device.modelID,
    manufacturer: device.manufacturerName,
    powerSource: device.powerSource,
    lastSeen: device.lastSeen,
    definition: def ? { vendor: def.vendor, model: def.model, description: def.description } : null,
  };
}

// ---------- HTTP API ----------

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /health") {
      return json(res, 200, { status: "ok", started });
    }

    if (route === "GET /devices") {
      if (!controller) return json(res, 503, { error: "not started" });
      const devices = controller.getDevices()
        .filter((d) => d.type !== "Coordinator")
        .map(buildDeviceInfo);
      return json(res, 200, { devices, states: deviceStates });
    }

    if (route === "GET /device") {
      const name = url.searchParams.get("name");
      const device = resolveDevice(name);
      if (!device) return json(res, 404, { error: `Device "${name}" not found` });
      const def = await resolveDef(device);
      return json(res, 200, {
        device: buildDeviceInfo(device),
        state: deviceStates[getName(device)] || {},
        definition: def,
      });
    }

    if (route === "POST /device/set") {
      const body = await readBody(req);
      const device = resolveDevice(body.device);
      if (!device) return json(res, 404, { error: `Device "${body.device}" not found` });
      const def = await resolveDef(device);
      const endpoint = device.getEndpoint(1) || device.endpoints[0];
      if (!endpoint) return json(res, 400, { error: "No endpoints" });

      const results = [];
      const converters = def?.toZigbee || [];
      for (const [key, value] of Object.entries(body.state || {})) {
        const conv = converters.find((c) => c.key?.includes(key));
        if (conv?.convertSet) {
          try {
            const meta = {
              message: body.state,
              device,
              mapped: def,
              options: {},
              state: deviceStates[getName(device)] || {},
              endpoint_name: undefined,
              publish: () => {},
            };
            const result = await conv.convertSet(endpoint, key, value, meta);
            if (result?.state) {
              const name = getName(device);
              deviceStates[name] = { ...(deviceStates[name] || {}), ...result.state };
            }
            results.push({ key, value, ok: true });
          } catch (err) {
            results.push({ key, value, ok: false, error: err.message });
          }
        } else {
          // Raw fallback
          try {
            if (key === "state") await endpoint.command("genOnOff", value === "ON" || value === true ? "on" : "off", {});
            else if (key === "brightness") await endpoint.command("genLevelCtrl", "moveToLevel", { level: Number(value), transtime: 0 });
            else if (key === "color_temp") await endpoint.command("lightingColorCtrl", "moveToColorTemp", { colortemp: Number(value), transtime: 0 });
            else throw new Error(`Unknown property: ${key}`);
            results.push({ key, value, ok: true, raw: true });
          } catch (err) {
            results.push({ key, value, ok: false, error: err.message });
          }
        }
      }
      return json(res, 200, { results });
    }

    if (route === "POST /permit-join") {
      const body = await readBody(req);
      await controller.permitJoin(body.seconds || 120);
      return json(res, 200, { ok: true, seconds: body.seconds || 120 });
    }

    if (route === "POST /disable-join") {
      await controller.permitJoin(0);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /rename") {
      const body = await readBody(req);
      const device = resolveDevice(body.old_name);
      if (!device) return json(res, 404, { error: `Device "${body.old_name}" not found` });
      const oldState = deviceStates[body.old_name];
      if (oldState) {
        delete deviceStates[body.old_name];
        deviceStates[body.new_name] = oldState;
      }
      friendlyNames[device.ieeeAddr] = body.new_name;
      saveNames();
      return json(res, 200, { ok: true, from: body.old_name, to: body.new_name });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("API error:", err);
    json(res, 500, { error: err.message });
  }
});

// ---------- Start ----------

server.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`Zigbee bridge HTTP API listening on http://127.0.0.1:${HTTP_PORT}`);
});

startController().catch((err) => {
  console.error("Failed to start zigbee controller:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  if (controller && started) {
    await controller.stop();
  }
  server.close();
  process.exit(0);
});
