import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupSmokeBrowser, removeSmokeDir, stopChrome } from "./csp-smoke.mjs";

const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

function whenSpawned(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

describe("CSP smoke cleanup", () => {
  it("kills chrome and removes its profile only after the process exits", async () => {
    const order = [];
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await whenSpawned(child);
    const realKill = child.kill.bind(child);
    child.kill = (signal) => {
      order.push("kill");
      return realKill(signal);
    };
    child.once("exit", () => order.push("exit"));

    const dir = await mkdtemp(join(tmpdir(), "csp-smoke-"));
    await writeFile(join(dir, "lock"), "x");
    await cleanupSmokeBrowser(child, dir, async (path, options) => {
      order.push("rm");
      expect(child.exitCode != null || child.signalCode != null).toBe(true);
      expect(path).toBe(dir);
      expect(options).toEqual(rmOptions);
      const { rm } = await import("node:fs/promises");
      await rm(path, options);
    });

    expect(order.indexOf("kill")).toBeLessThan(order.indexOf("exit"));
    expect(order.indexOf("exit")).toBeLessThan(order.indexOf("rm"));
    await expect(stat(dir)).rejects.toThrow();
  });

  it("still removes the profile when chrome has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolve) => child.once("exit", resolve));
    const dir = await mkdtemp(join(tmpdir(), "csp-smoke-"));
    await cleanupSmokeBrowser(child, dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("warns and resolves when removing the profile fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reason = new Error("ENOTEMPTY: directory not empty, rmdir '/tmp/csp-smoke-x'");
    const remove = vi.fn(async () => {
      throw reason;
    });
    await expect(removeSmokeDir("/tmp/csp-smoke-x", remove)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("/tmp/csp-smoke-x", rmOptions);
    expect(warn).toHaveBeenCalledWith("CSP smoke cleanup failed:", reason.message);
    warn.mockRestore();
  });

  it("resolves stopChrome after the process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await whenSpawned(child);
    await stopChrome(child);
    expect(child.signalCode).toBe("SIGKILL");
  });
});
