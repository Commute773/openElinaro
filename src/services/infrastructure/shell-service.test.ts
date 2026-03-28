import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LocalShellBackend } from "../shell-backend-local";
import { ShellService } from "./shell-service";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shell-service-test-"));
}

describe("ShellService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("exec", () => {
    test("runs a simple command and returns stdout", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "echo hello" });

      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(result.sudo).toBe(false);
    });

    test("captures stderr from a failing command", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "ls /nonexistent-path-xyz-123" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    test("respects the cwd parameter", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "pwd", cwd: tmpDir });

      // Resolve both to handle symlinks (e.g. /tmp -> /private/tmp on macOS)
      const actual = fs.realpathSync(result.stdout.trim());
      const expected = fs.realpathSync(tmpDir);
      expect(actual).toBe(expected);
    });

    test("resolves relative cwd against process.cwd()", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "pwd", cwd: "." });

      expect(result.cwd).toBe(process.cwd());
    });

    test("uses default cwd when cwd is not provided", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "echo ok" });

      expect(result.cwd).toBe(process.cwd());
    });

    test("returns exitCode 124 when command times out", async () => {
      const service = new ShellService();
      const result = await service.exec({
        command: "sleep 30",
        timeoutMs: 200,
      });

      expect(result.exitCode).toBe(124);
    });

    test("sets sudo flag in result when sudo=true", async () => {
      const service = new ShellService();
      // sudo will fail in test, but we can verify the flag and command prefix
      const result = await service.exec({ command: "echo test", sudo: true });

      expect(result.sudo).toBe(true);
      expect(result.command).toContain("sudo");
    });

    test("reports effectiveUser from process.env.USER", async () => {
      const service = new ShellService();
      const result = await service.exec({ command: "echo ok" });

      expect(result.effectiveUser).toBe(process.env.USER ?? "unknown");
    });

    test("uses custom shell binary from environment", async () => {
      const service = new ShellService(new LocalShellBackend({
        OPENELINARO_SHELL_BIN: "/bin/sh",
      }));
      const result = await service.exec({ command: "echo ok" });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });
  });

  describe("execVerification", () => {
    test("runs a command as a verification operation", async () => {
      const service = new ShellService();
      const result = await service.execVerification({ command: "echo verify" });

      expect(result.stdout.trim()).toBe("verify");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("buildCommandInvocation (via exec behavior)", () => {
    test("throws when sudo=true with a configured shell user", async () => {
      const service = new ShellService(new LocalShellBackend({
        OPENELINARO_PROFILE_SHELL_USER: "restricted",
      }));

      await expect(
        service.exec({ command: "echo test", sudo: true }),
      ).rejects.toThrow("sudo=true is only available when running as the root profile.");
    });

    test("uses sudo -n -H -u when shell user is configured", async () => {
      const service = new ShellService(new LocalShellBackend({
        OPENELINARO_PROFILE_SHELL_USER: "testuser",
      }));

      // This will fail because sudo isn't set up, but we can verify the effective user
      const result = await service.exec({ command: "echo test" });
      expect(result.effectiveUser).toBe("testuser");
    });
  });

  describe("access control integration", () => {
    test("calls assertToolAllowed on exec", async () => {
      const assertToolAllowed = mock(() => {});
      const assertPathAccess = mock((p: string) => p);
      const access = {
        assertToolAllowed,
        assertPathAccess,
      } as any;

      const service = new ShellService(undefined, access);
      await service.exec({ command: "echo ok" });

      expect(assertToolAllowed).toHaveBeenCalledWith("exec_command");
      expect(assertPathAccess).toHaveBeenCalled();
    });

    test("throws when access control denies tool", async () => {
      const access = {
        assertToolAllowed: () => {
          throw new Error("Denied");
        },
        assertPathAccess: (p: string) => p,
      } as any;

      const service = new ShellService(undefined, access);
      await expect(service.exec({ command: "echo no" })).rejects.toThrow("Denied");
    });
  });

  describe("background jobs", () => {
    test("launchBackground starts a job and returns job metadata", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: `echo bg-test`,
        cwd: tmpDir,
      });

      expect(job.id).toMatch(/^shell-/);
      expect(job.status).toBe("running");
      expect(job.command).toBe("echo bg-test");
      expect(job.sudo).toBe(false);
      expect(job.pid).toBeGreaterThan(0);
      expect(job.outputLineCount).toBe(0);

      // Wait for the job to finish
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("listBackgroundJobs returns launched jobs", async () => {
      const service = new ShellService();
      service.launchBackground({ command: "echo a", cwd: tmpDir });
      service.launchBackground({ command: "echo b", cwd: tmpDir });

      const jobs = service.listBackgroundJobs();
      expect(jobs.length).toBe(2);

      // Wait for jobs to finish
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("listBackgroundJobs respects limit", async () => {
      const service = new ShellService();
      service.launchBackground({ command: "echo 1", cwd: tmpDir });
      service.launchBackground({ command: "echo 2", cwd: tmpDir });
      service.launchBackground({ command: "echo 3", cwd: tmpDir });

      const jobs = service.listBackgroundJobs(2);
      expect(jobs.length).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("getBackgroundJob returns a specific job by id", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({ command: "echo find-me", cwd: tmpDir });

      const found = service.getBackgroundJob(job.id);
      expect(found).toBeDefined();
      expect(found!.command).toBe("echo find-me");

      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("getBackgroundJob returns undefined for unknown id", () => {
      const service = new ShellService();
      expect(service.getBackgroundJob("nonexistent")).toBeUndefined();
    });

    test("readBackgroundOutput returns output lines after job completes", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: "echo line1 && echo line2 && echo line3",
        cwd: tmpDir,
      });

      // Wait for the job to finish
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const output = service.readBackgroundOutput({ id: job.id });
      expect(output.totalLines).toBeGreaterThanOrEqual(3);
      expect(output.lines).toContain("line1");
      expect(output.lines).toContain("line2");
      expect(output.lines).toContain("line3");
    });

    test("readBackgroundOutput supports tailLines", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: "echo a && echo b && echo c && echo d",
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const output = service.readBackgroundOutput({ id: job.id, tailLines: 2 });
      expect(output.lines.length).toBe(2);
      expect(output.lines).toContain("c");
      expect(output.lines).toContain("d");
    });

    test("readBackgroundOutput supports offset and limit", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: "echo a && echo b && echo c && echo d",
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const output = service.readBackgroundOutput({ id: job.id, offset: 2, limit: 2 });
      expect(output.startLine).toBe(2);
      expect(output.lines.length).toBe(2);
    });

    test("readBackgroundOutput throws for unknown job id", () => {
      const service = new ShellService();
      expect(() =>
        service.readBackgroundOutput({ id: "no-such-job" }),
      ).toThrow("No background shell job found");
    });

    test("completed job has status completed and exitCode 0", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: "echo done",
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const updated = service.getBackgroundJob(job.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.exitCode).toBe(0);
      expect(updated!.completedAt).toBeDefined();
    });

    test("failed job has status failed and nonzero exitCode", async () => {
      const service = new ShellService();
      const { job } = service.launchBackground({
        command: "exit 42",
        cwd: tmpDir,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const updated = service.getBackgroundJob(job.id);
      expect(updated!.status).toBe("failed");
      expect(updated!.exitCode).toBe(42);
    });
  });

  describe("consumeConversationNotifications", () => {
    test("returns empty array when no notifications exist", () => {
      const service = new ShellService();
      const notifications = service.consumeConversationNotifications("conv-1");
      expect(notifications).toEqual([]);
    });

    test("returns and clears notifications for a completed background job", async () => {
      const service = new ShellService();
      service.launchBackground({
        command: "echo notify-me",
        cwd: tmpDir,
        conversationKey: "conv-test",
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const notifications = service.consumeConversationNotifications("conv-test");
      expect(notifications.length).toBe(1);
      expect(notifications[0]).toContain("Background exec completed");
      expect(notifications[0]).toContain("notify-me");

      // Second call should return empty
      const again = service.consumeConversationNotifications("conv-test");
      expect(again).toEqual([]);
    });
  });
});
