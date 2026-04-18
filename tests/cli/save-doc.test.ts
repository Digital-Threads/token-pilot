/**
 * TP-89n — save-doc helper.
 *
 * `token-pilot save-doc <name>` persists arbitrary text (WebFetch results,
 * scraped docs, long research notes) to `.token-pilot/docs/<name>.md` so
 * it survives compaction and can be cheaply re-read via `read_range` /
 * `smart_read` instead of re-fetching.
 *
 * `token-pilot list-docs` enumerates saved docs with size + mtime.
 *
 * Safety rules tested:
 *   - name must be slug-like (no "../", no "/", no absolute paths)
 *   - source text required (stdin or --content)
 *   - overwrite is explicit (no silent replacement of existing doc)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveDoc,
  listDocs,
  normalizeDocName,
  DOCS_SUBDIR,
} from "../../src/cli/save-doc.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "tp-save-doc-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("normalizeDocName", () => {
  it("accepts slug-like names", () => {
    expect(normalizeDocName("react-hooks")).toBe("react-hooks");
    expect(normalizeDocName("api_v2.notes")).toBe("api_v2.notes");
  });

  it("strips .md suffix if provided", () => {
    expect(normalizeDocName("notes.md")).toBe("notes");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => normalizeDocName("../escape")).toThrow(/invalid doc name/i);
    expect(() => normalizeDocName("/etc/passwd")).toThrow(/invalid doc name/i);
    expect(() => normalizeDocName("a/b")).toThrow(/invalid doc name/i);
    expect(() => normalizeDocName("")).toThrow(/invalid doc name/i);
  });

  it("rejects control chars and spaces", () => {
    expect(() => normalizeDocName("foo bar")).toThrow(/invalid doc name/i);
    expect(() => normalizeDocName("foo\nbar")).toThrow(/invalid doc name/i);
  });
});

describe("saveDoc", () => {
  it("creates .token-pilot/docs/<name>.md with the given content", async () => {
    const res = await saveDoc({
      projectRoot: tempDir,
      name: "notes",
      content: "Hello world\n",
    });
    expect(res.saved).toBe(true);
    const path = join(tempDir, DOCS_SUBDIR, "notes.md");
    expect(await readFile(path, "utf-8")).toBe("Hello world\n");
  });

  it("refuses to overwrite without overwrite:true", async () => {
    await saveDoc({ projectRoot: tempDir, name: "x", content: "first" });
    const second = await saveDoc({
      projectRoot: tempDir,
      name: "x",
      content: "second",
    });
    expect(second.saved).toBe(false);
    expect(second.reason).toMatch(/already exists/i);
    const path = join(tempDir, DOCS_SUBDIR, "x.md");
    expect(await readFile(path, "utf-8")).toBe("first");
  });

  it("overwrites when overwrite:true", async () => {
    await saveDoc({ projectRoot: tempDir, name: "x", content: "first" });
    const res = await saveDoc({
      projectRoot: tempDir,
      name: "x",
      content: "second",
      overwrite: true,
    });
    expect(res.saved).toBe(true);
    const path = join(tempDir, DOCS_SUBDIR, "x.md");
    expect(await readFile(path, "utf-8")).toBe("second");
  });

  it("rejects empty content", async () => {
    const res = await saveDoc({
      projectRoot: tempDir,
      name: "empty",
      content: "",
    });
    expect(res.saved).toBe(false);
    expect(res.reason).toMatch(/empty/i);
  });

  it("propagates invalid-name errors", async () => {
    await expect(
      saveDoc({ projectRoot: tempDir, name: "../x", content: "z" }),
    ).rejects.toThrow(/invalid doc name/i);
  });
});

describe("listDocs", () => {
  it("returns [] when the docs dir does not exist", async () => {
    const docs = await listDocs(tempDir);
    expect(docs).toEqual([]);
  });

  it("lists saved docs with size + mtime, sorted by name", async () => {
    await saveDoc({ projectRoot: tempDir, name: "bravo", content: "bb" });
    await saveDoc({ projectRoot: tempDir, name: "alpha", content: "aaaa" });
    const docs = await listDocs(tempDir);
    expect(docs.map((d) => d.name)).toEqual(["alpha", "bravo"]);
    expect(docs[0].bytes).toBe(4);
    expect(docs[1].bytes).toBe(2);
    const alphaStat = await stat(join(tempDir, DOCS_SUBDIR, "alpha.md"));
    expect(Math.abs(docs[0].mtimeMs - alphaStat.mtimeMs)).toBeLessThan(1000);
  });

  it("ignores non-.md files", async () => {
    await saveDoc({ projectRoot: tempDir, name: "keep", content: "x" });
    // drop a non-md sibling
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, DOCS_SUBDIR, "ignore.txt"), "y");
    const docs = await listDocs(tempDir);
    expect(docs.map((d) => d.name)).toEqual(["keep"]);
  });
});
