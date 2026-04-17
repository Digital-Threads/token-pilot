import { describe, it, expect } from "vitest";
import { parseRegexSummary } from "../../src/hooks/summary-regex.js";

describe("parseRegexSummary — TypeScript", () => {
  const ts = `import { foo } from './foo';
import bar from 'bar';

export const VERSION = '1.0.0';

export function greet(name: string): string {
  return \`hi \${name}\`;
}

export class Greeter {
  constructor(private name: string) {}
  greet(): string { return this.name; }
}

interface Internal {
  x: number;
}

export type Id = string | number;
`;

  it("captures imports", () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    const imports = summary.signals.filter((s) => s.kind === "import");
    expect(imports).toHaveLength(2);
    expect(imports[0].text).toContain("./foo");
  });

  it("captures exports (const, function, class, type)", () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    const exports = summary.signals.filter((s) => s.kind === "export");
    expect(exports.length).toBeGreaterThanOrEqual(4);
    const exportText = exports.map((e) => e.text).join("\n");
    expect(exportText).toContain("VERSION");
    expect(exportText).toContain("function greet");
    expect(exportText).toContain("class Greeter");
    expect(exportText).toContain("type Id");
  });

  it('captures non-exported declarations as "declaration" kind', () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    const decls = summary.signals.filter((s) => s.kind === "declaration");
    expect(decls.some((d) => d.text.includes("interface Internal"))).toBe(true);
  });

  it("records correct 1-based line numbers", () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    const greetFn = summary.signals.find((s) =>
      s.text.includes("function greet"),
    );
    // greet is on line 6 in the fixture (1-based)
    expect(greetFn?.line).toBe(6);
  });

  it('sets language="ts" from the .ts extension', () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    expect(summary.language).toBe("ts");
  });

  it("tracks total line count", () => {
    const summary = parseRegexSummary(ts, "src/demo.ts");
    expect(summary.totalLines).toBe(ts.split("\n").length);
  });
});

describe("parseRegexSummary — JavaScript", () => {
  const js = `const path = require('path');
module.exports = function run(opts) {
  return opts.x;
};
exports.helper = () => 42;
`;

  it("captures CommonJS requires as imports", () => {
    const summary = parseRegexSummary(js, "x.js");
    const imports = summary.signals.filter((s) => s.kind === "import");
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports[0].text).toContain("require");
  });

  it("captures module.exports and exports.* as exports", () => {
    const summary = parseRegexSummary(js, "x.js");
    const exports = summary.signals.filter((s) => s.kind === "export");
    const text = exports.map((e) => e.text).join("\n");
    expect(text).toContain("module.exports");
    expect(text).toMatch(/exports\.helper/);
  });
});

describe("parseRegexSummary — Python", () => {
  const py = `from typing import List
import os

def compute(xs: List[int]) -> int:
    return sum(xs)

class Cache:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

async def fetch(url):
    pass
`;

  it("captures imports", () => {
    const summary = parseRegexSummary(py, "mod.py");
    const imports = summary.signals.filter((s) => s.kind === "import");
    expect(imports).toHaveLength(2);
  });

  it("captures def and class as declarations", () => {
    const summary = parseRegexSummary(py, "mod.py");
    const decls = summary.signals.filter(
      (s) => s.kind === "declaration" || s.kind === "export",
    );
    const text = decls.map((d) => d.text).join("\n");
    expect(text).toContain("def compute");
    expect(text).toContain("class Cache");
    expect(text).toContain("async def fetch");
  });
});

describe("parseRegexSummary — Go", () => {
  const go = `package main

import (
    "fmt"
    "os"
)

func main() {
    fmt.Println("hi")
}

type Server struct {
    port int
}

func (s *Server) Start() error {
    return nil
}

type Handler interface {
    Handle(req string) string
}
`;

  it("captures func, type struct, type interface", () => {
    const summary = parseRegexSummary(go, "main.go");
    const text = summary.signals.map((s) => s.text).join("\n");
    expect(text).toContain("func main");
    expect(text).toContain("type Server struct");
    expect(text).toContain("type Handler interface");
  });
});

describe("parseRegexSummary — Rust", () => {
  const rs = `use std::collections::HashMap;

pub fn greet(name: &str) -> String {
    format!("hi {}", name)
}

pub struct Counter {
    n: u32,
}

pub trait Stored {
    fn load(&self) -> String;
}

enum Color {
    Red,
    Green,
}
`;

  it("captures use, fn, struct, trait, enum", () => {
    const summary = parseRegexSummary(rs, "lib.rs");
    const text = summary.signals.map((s) => s.text).join("\n");
    expect(text).toContain("use std::collections");
    expect(text).toContain("pub fn greet");
    expect(text).toContain("pub struct Counter");
    expect(text).toContain("pub trait Stored");
    expect(text).toContain("enum Color");
  });
});

describe("parseRegexSummary — edge cases", () => {
  it("returns empty signals for empty content", () => {
    const summary = parseRegexSummary("", "empty.ts");
    expect(summary.signals).toEqual([]);
    expect(summary.totalLines).toBe(1); // split('\n') on '' yields ['']
  });

  it("returns empty signals but totals for content with no declarations", () => {
    const summary = parseRegexSummary(
      "// just a comment\n// and another",
      "x.ts",
    );
    expect(summary.signals).toEqual([]);
    expect(summary.totalLines).toBe(2);
  });

  it("returns empty signals for unsupported extension", () => {
    const summary = parseRegexSummary("some text", "README.md");
    expect(summary.signals).toEqual([]);
    expect(summary.language).toBe("md");
  });

  it("truncates very long signal text to 140 chars", () => {
    const long = "export function x(" + "a: number, ".repeat(30) + "): void {}";
    const summary = parseRegexSummary(long, "long.ts");
    expect(summary.signals[0].text.length).toBeLessThanOrEqual(140);
  });

  it("returns estimatedTokens roughly content.length / 4", () => {
    const content = "export function foo() {}\n".repeat(10);
    const summary = parseRegexSummary(content, "x.ts");
    expect(summary.estimatedTokens).toBeGreaterThan(0);
    expect(summary.estimatedTokens).toBeLessThan(content.length);
  });
});
