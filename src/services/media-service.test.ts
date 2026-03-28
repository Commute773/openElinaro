import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { MediaService } from "./media-service";

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "media-service-"));
}

function writeFile(filePath: string, contents = "stub") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeSpeakerConfig(filePath: string) {
  writeFile(filePath, `${JSON.stringify({
    speakers: [
      {
        id: "bedroom",
        name: "B06HD",
        aliases: ["bedroom", "b06hd"],
        device_name: "B06HD",
        bt_address: "9d-33-92-14-57-9e",
        transport: "bluetooth",
      },
      {
        id: "macbook",
        name: "MacBook",
        aliases: ["macbook"],
        device_name: "MacBook Pro Speakers",
        transport: "built-in",
      },
    ],
  }, null, 2)}\n`);
}

describe("MediaService", () => {
  test("indexes ambience from local media roots", () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const extraMedia = path.join(tempRoot, "extra-media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const localThunder = path.join(localMedia, "ambience", "thunder.mp3");
      const extraThunder = path.join(extraMedia, "thunder.mp3");
      writeFile(localThunder);
      writeFile(extraThunder);
      writeSpeakerConfig(speakerConfigPath);

      const service = new MediaService({
        mediaRoots: [localMedia, extraMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
      });

      const result = service.listMedia({ kind: "ambience" });
      const assistantContext = service.buildAssistantContext();

      expect(result.total).toBe(2);
      expect(result.counts.ambience).toBe(2);
      expect(result.items.some((item) => item.id === "thunder-noises")).toBe(true);
      expect(result.items.every((item) => item.tags.includes("thunder"))).toBe(true);
      expect(result.items.every((item) => item.source === "local")).toBe(true);
      expect(assistantContext).toContain("bedroom=B06HD");
      expect(assistantContext).toContain("2 ambience track(s)");
      expect(assistantContext).toContain("0 song(s)");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("defaults media roots and catalog to the runtime media directory", () => {
    const tempRoot = createTempRoot();
    const originalRootDir = process.env.OPENELINARO_ROOT_DIR;
    try {
      process.env.OPENELINARO_ROOT_DIR = tempRoot;
      const runtimeMediaRoot = path.join(tempRoot, ".openelinarotest", "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      writeFile(path.join(runtimeMediaRoot, "ambience", "thunder.mp3"));
      writeFile(
        path.join(runtimeMediaRoot, "catalog.json"),
        `${JSON.stringify({
          tracks: [
            {
              id: "thunder-noises",
              title: "Thunder Noises",
              file: "ambience/thunder.mp3",
              tags: ["thunder", "storm"],
              category: "ambience",
            },
          ],
        }, null, 2)}\n`,
      );
      writeSpeakerConfig(speakerConfigPath);

      const service = new MediaService({
        speakerConfigPath,
        stateRoot,
        runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
      });

      const result = service.listMedia({ kind: "ambience" });

      expect(result.total).toBe(1);
      expect(result.items[0]?.relativePath).toBe("ambience/thunder.mp3");
      expect(result.items[0]?.source).toBe("local");
      expect(result.items[0]?.id).toBe("thunder-noises");
    } finally {
      if (originalRootDir === undefined) {
        delete process.env.OPENELINARO_ROOT_DIR;
      } else {
        process.env.OPENELINARO_ROOT_DIR = originalRootDir;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("merges configured speakers with live output devices", async () => {
    const tempRoot = createTempRoot();
    try {
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      writeSpeakerConfig(speakerConfigPath);

      const service = new MediaService({
        mediaRoots: [path.join(tempRoot, "media")],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot: path.join(tempRoot, ".openelinarotest", "media"),
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        runCommand: async ({ file, args }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return {
              stdout: "B06HD\nMacBook Pro Speakers\n",
              stderr: "",
              exitCode: 0,
            };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return {
              stdout: "B06HD\n",
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
          };
        },
      });

      const speakers = await service.listSpeakers();
      const bedroom = speakers.find((speaker) => speaker.id === "bedroom");
      const macbook = speakers.find((speaker) => speaker.id === "macbook");

      expect(bedroom?.available).toBe(true);
      expect(bedroom?.isCurrentOutput).toBe(true);
      expect(macbook?.available).toBe(true);
      expect(speakers[0]?.name).toBe("B06HD");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("plays media on a speaker and supports status, volume, and stop", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      let currentVolume = 70;
      let socketPath = "";
      const ncInputs: string[] = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            ncInputs.push(input ?? "");
            if (input?.includes('"get_property","pid"')) {
              return { stdout: '{"data":321}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","pause"')) {
              return { stdout: '{"data":false}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","volume"')) {
              return { stdout: `{"data":${currentVolume}}\n`, stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","path"')) {
              return { stdout: `{"data":"${thunderPath}"}\n`, stderr: "", exitCode: 0 };
            }
            if (input?.includes('"set_property","volume"')) {
              const parsed = JSON.parse(input);
              currentVolume = parsed.command[2];
              return { stdout: "", stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 321 };
        },
      });

      const playResult = await service.play({
        query: "thunder",
        speaker: "bedroom",
        volume: 70,
      });
      const status = await service.getStatus("bedroom");
      await service.setVolume(55, "bedroom");
      const stopped = await service.stop("bedroom");

      expect(playResult.item.title).toContain("Thunder");
      expect(playResult.item.source).toBe("local");
      expect(playResult.speaker.id).toBe("bedroom");
      expect(status.state).toBe("playing");
      expect(status.volume).toBe(70);
      expect(status.media?.title).toContain("Thunder");
      expect(currentVolume).toBe(55);
      expect(ncInputs.some((input) => input.includes('"set_property","volume",55'))).toBe(true);
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(stopped.state).toBe("stopped");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("kills a lingering player before restarting the same speaker", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      const alive = new Set<number>([111]);
      const signalled: Array<{ pid: number; signal: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        playerReadyTimeoutMs: 100,
        playerStopTimeoutMs: 100,
        processIsAlive: (pid) => alive.has(pid),
        signalProcess: (pid, signal) => {
          signalled.push({ pid, signal });
          alive.delete(pid);
        },
        runCommand: async ({ file, args }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            return { stdout: '{"data":222}\n', stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          const socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          alive.add(222);
          return { pid: 222 };
        },
      });

      const staleSocket = path.join(stateRoot, "sockets", "mpv-bedroom.sock");
      writeFile(staleSocket);
      writeFile(
        path.join(stateRoot, "players", "bedroom.json"),
        `${JSON.stringify({
          speakerId: "bedroom",
          speakerName: "B06HD",
          deviceName: "B06HD",
          mediaId: "thunder-noises",
          mediaTitle: "Thunder Noises",
          mediaPath: thunderPath,
          mediaKind: "ambience",
          mediaTags: ["thunder"],
          startedAt: "2026-03-14T00:00:00.000Z",
          loop: true,
          volume: 80,
          pid: 111,
        }, null, 2)}\n`,
      );

      const result = await service.play({
        query: "thunder",
        speaker: "bedroom",
      });

      expect(result.pid).toBe(222);
      expect(signalled).toContainEqual({ pid: 111, signal: "SIGTERM" });
      const metadata = JSON.parse(
        fs.readFileSync(path.join(stateRoot, "players", "bedroom.json"), "utf8"),
      ) as { pid: number };
      expect(metadata.pid).toBe(222);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("fails playback when mpv never exposes its IPC socket", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      const alive = new Set<number>([333]);
      const signalled: Array<{ pid: number; signal: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        playerReadyTimeoutMs: 60,
        playerStopTimeoutMs: 60,
        processIsAlive: (pid) => alive.has(pid),
        signalProcess: (pid, signal) => {
          signalled.push({ pid, signal });
          alive.delete(pid);
        },
        runCommand: async ({ file, args }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async () => ({ pid: 333 }),
      });

      await expect(service.play({
        query: "thunder",
        speaker: "bedroom",
      })).rejects.toThrow("mpv failed to initialize control socket");

      expect(signalled).toContainEqual({ pid: 333, signal: "SIGTERM" });
      expect(fs.existsSync(path.join(stateRoot, "players", "bedroom.json"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("uses a short tmp socket root even when the media state root path is long", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const longStateRoot = path.join(
        tempRoot,
        "very-long-state-root",
        "nested",
        "media",
        "state",
        "that",
        "would",
        "otherwise",
        "make",
        "unix",
        "socket",
        "paths",
        "too",
        "long",
      );
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      let socketPath = "";

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot: longStateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc" && input?.includes('"get_property","pid"')) {
            return { stdout: '{"data":777}\n', stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 777 };
        },
      });

      await service.play({
        query: "thunder",
        speaker: "bedroom",
      });

      expect(socketPath.startsWith(os.tmpdir())).toBe(true);
      expect(socketPath.length).toBeLessThan(104);
      expect(socketPath).not.toContain(longStateRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("fires onPlaybackEnd callback when eof-reached becomes true", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      let eofReached = false;
      const events: Array<{ speakerId: string; title: string; reason: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        eofPollIntervalMs: 500,
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            if (input?.includes('"get_property","pid"')) {
              return { stdout: '{"data":444}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","eof-reached"')) {
              return { stdout: `{"data":${eofReached}}\n`, stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","pause"')) {
              return { stdout: '{"data":false}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","volume"')) {
              return { stdout: '{"data":80}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","path"')) {
              return { stdout: `{"data":"${thunderPath}"}\n`, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          const socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 444 };
        },
      });

      service.onPlaybackEnd((event) => {
        events.push(event);
      });

      await service.play({
        query: "thunder",
        speaker: "bedroom",
        volume: 80,
        loop: false,
      });

      // Simulate EOF by flipping the flag
      eofReached = true;

      // Wait for the poll to fire (poll interval is 500ms)
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(events.length).toBe(1);
      expect(events[0]?.speakerId).toBe("bedroom");
      expect(events[0]?.title).toContain("Thunder");
      expect(events[0]?.reason).toBe("eof");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not fire onPlaybackEnd for looped tracks", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      const events: Array<{ speakerId: string; title: string; reason: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        eofPollIntervalMs: 500,
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            if (input?.includes('"get_property","pid"')) {
              return { stdout: '{"data":555}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","eof-reached"')) {
              return { stdout: '{"data":true}\n', stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          const socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 555 };
        },
      });

      service.onPlaybackEnd((event) => {
        events.push(event);
      });

      // Play with loop=true (ambience defaults to loop)
      await service.play({
        query: "thunder",
        speaker: "bedroom",
        volume: 80,
        loop: true,
      });

      // Wait for potential poll cycles
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(events.length).toBe(0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("stopSpeaker clears the EOF watcher without firing callback", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      const events: Array<{ speakerId: string; title: string; reason: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        eofPollIntervalMs: 500,
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            if (input?.includes('"get_property","pid"')) {
              return { stdout: '{"data":666}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","eof-reached"')) {
              return { stdout: '{"data":false}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","pause"')) {
              return { stdout: '{"data":false}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","volume"')) {
              return { stdout: '{"data":80}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","path"')) {
              return { stdout: `{"data":"${thunderPath}"}\n`, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          const socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 666 };
        },
      });

      service.onPlaybackEnd((event) => {
        events.push(event);
      });

      await service.play({
        query: "thunder",
        speaker: "bedroom",
        volume: 80,
        loop: false,
      });

      // Stop immediately — should clear the watcher
      await service.stop("bedroom");

      // Wait for potential poll cycles that should not fire
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(events.length).toBe(0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("unsubscribe from onPlaybackEnd removes the callback", async () => {
    const tempRoot = createTempRoot();
    try {
      const localMedia = path.join(tempRoot, "media");
      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      const thunderPath = path.join(localMedia, "ambient", "thunder.mp3");
      writeFile(thunderPath);
      writeSpeakerConfig(speakerConfigPath);

      let eofReached = false;
      const events: Array<{ speakerId: string; title: string; reason: string }> = [];

      const service = new MediaService({
        mediaRoots: [localMedia],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: "switchaudio",
        blueutilBin: "blueutil",
        mpvBin: "mpv",
        ncBin: "nc",
        osascriptBin: "osascript",
        eofPollIntervalMs: 500,
        runCommand: async ({ file, args, input }) => {
          if (file === "switchaudio" && args?.join(" ") === "-a -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "switchaudio" && args?.join(" ") === "-c -t output") {
            return { stdout: "B06HD\n", stderr: "", exitCode: 0 };
          }
          if (file === "nc") {
            if (input?.includes('"get_property","pid"')) {
              return { stdout: '{"data":777}\n', stderr: "", exitCode: 0 };
            }
            if (input?.includes('"get_property","eof-reached"')) {
              return { stdout: `{"data":${eofReached}}\n`, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        spawnDetached: async ({ args }) => {
          const socketArg = args?.find((arg) => arg.startsWith("--input-ipc-server="));
          const socketPath = socketArg?.split("=", 2)[1] ?? "";
          writeFile(socketPath);
          return { pid: 777 };
        },
      });

      const unsubscribe = service.onPlaybackEnd((event) => {
        events.push(event);
      });

      await service.play({
        query: "thunder",
        speaker: "bedroom",
        volume: 80,
        loop: false,
      });

      // Unsubscribe before EOF fires
      unsubscribe();
      eofReached = true;

      // Wait for the poll to fire
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // No events because we unsubscribed
      expect(events.length).toBe(0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("round-trips playback control against a real local mpv process", async () => {
    if (process.platform !== "darwin" || !fs.existsSync("/opt/homebrew/bin/mpv")) {
      return;
    }

    const tempRoot = createTempRoot();
    try {
      const repoThunder = path.join(os.homedir(), ".openelinaro", "media", "ambience", "thunder.mp3");
      if (!fs.existsSync(repoThunder)) {
        return;
      }

      const speakerConfigPath = path.join(tempRoot, "speakers.json");
      const stateRoot = path.join(tempRoot, ".openelinarotest", "media");
      writeSpeakerConfig(speakerConfigPath);

      const fakeSwitchAudioSource = path.join(tempRoot, "bin", "switchaudio");
      const fakeBlueutil = path.join(tempRoot, "bin", "blueutil");
      const fakeOsaScript = path.join(tempRoot, "bin", "osascript");
      writeFile(fakeSwitchAudioSource, "#!/bin/sh\nif [ \"$1\" = \"-a\" ]; then printf 'MacBook Pro Speakers\\n'; exit 0; fi\nif [ \"$1\" = \"-c\" ]; then printf 'MacBook Pro Speakers\\n'; exit 0; fi\nexit 0\n");
      writeFile(fakeBlueutil, "#!/bin/sh\nexit 0\n");
      writeFile(fakeOsaScript, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(fakeSwitchAudioSource, 0o755);
      fs.chmodSync(fakeBlueutil, 0o755);
      fs.chmodSync(fakeOsaScript, 0o755);

      const service = new MediaService({
        mediaRoots: [path.dirname(repoThunder)],
        catalogPath: path.join(tempRoot, "missing-catalog.json"),
        speakerConfigPath,
        stateRoot,
        switchAudioSourceBin: fakeSwitchAudioSource,
        blueutilBin: fakeBlueutil,
        mpvBin: "/opt/homebrew/bin/mpv",
        ncBin: "/usr/bin/nc",
        osascriptBin: fakeOsaScript,
        socketRoot: path.join(tempRoot, "sockets"),
      });

      const result = await service.play({
        query: repoThunder,
        speaker: "macbook",
        volume: 0,
        loop: false,
      });
      const status = await service.getStatus("macbook");
      const stopped = await service.stop("macbook");

      expect(result.pid).toBeGreaterThan(0);
      expect(status.state).toBe("playing");
      expect(status.path).toBe(repoThunder);
      expect(stopped.state).toBe("stopped");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
