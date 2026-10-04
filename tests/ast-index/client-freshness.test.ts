/**
 * New and changed files are invisible until `ast-index update` runs (the
 * watcher only knows files already read; the periodic update is 5 min).
 * Query tools freshen the index first — at most every 15 s — and when that
 * fails the client reports the index as possibly stale.
 */
import { describe, expect, it, vi } from "vitest";
import { AstIndexClient } from "../../src/ast-index/client.js";

function indexedClient(exec: (args: string[]) => Promise<string>): any {
  const client = new AstIndexClient("/repo") as any;
  client.binaryPath = "/bin/ast-index";
  client.indexed = true;
  client.exec = vi.fn(exec);
  return client;
}

describe("AstIndexClient freshness", () => {
  it("runs `update` before a query when the last refresh is older than 15 s, once", async () => {
    const client = indexedClient(async () => "");
    client.lastFresh = Date.now() - 60_000;

    await Promise.all([client.ensureIndex(), client.ensureIndex()]);
    await client.ensureIndex();

    const updates = client.exec.mock.calls.filter((c: string[][]) => c[0][0] === "update");
    expect(updates).toHaveLength(1);
    expect(client.isStale()).toBe(false);
  });

  it("skips the update right after a refresh", async () => {
    const client = indexedClient(async () => "");
    client.lastFresh = Date.now();

    await client.ensureIndex();

    expect(client.exec).not.toHaveBeenCalled();
  });

  it("reports a stale index when the update fails, and recovers on the next success", async () => {
    let fail = true;
    const client = indexedClient(async () => {
      if (fail) throw new Error("timeout");
      return "";
    });
    client.lastFresh = 0;

    await client.ensureIndex();
    expect(client.isStale()).toBe(true);

    fail = false;
    client.lastFresh = 0;
    await client.ensureIndex();
    expect(client.isStale()).toBe(false);
  });

  it("runs one `update` at a time: a periodic update and a query refresh share it", async () => {
    const pending: Array<() => void> = [];
    const client = indexedClient(
      (args) =>
        args[0] === "update"
          ? new Promise<string>((r) => pending.push(() => r("Index is up to date.")))
          : Promise.resolve(""),
    );
    client.lastFresh = 0;

    const both = Promise.all([client.incrementalUpdate(), client.ensureIndex()]);
    await Promise.resolve();
    pending.forEach((release) => release());
    await both;

    const updates = client.exec.mock.calls.filter((c: string[][]) => c[0][0] === "update");
    expect(updates).toHaveLength(1);
  });

  it("does not report a stale index when another process is already updating it", async () => {
    const client = indexedClient(async () => {
      throw new Error("Command failed: ast-index update\nError: Another rebuild is already running");
    });
    client.lastFresh = 0;

    await client.ensureIndex();

    expect(client.isStale()).toBe(false);
  });
});
