import { describe, it, expect } from "vitest";
import { handleModuleRoute } from "../../src/handlers/module-route.js";
import { validateModuleRouteArgs } from "../../src/core/validation.js";

describe("handleModuleRoute", () => {
  const root = "/repo";

  it("returns degraded guidance when ast-index is unavailable", async () => {
    const result = await handleModuleRoute(
      { from: "a", to: "b" },
      root,
      { isDisabled: () => true, isOversized: () => false } as any,
    );
    expect(result.content[0].text).toContain("module_route requires ast-index");
  });

  it("frames text output with a header", async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      moduleRoute: async () => "apps/api → core → db",
    } as any;
    const result = await handleModuleRoute({ from: "apps/api", to: "db" }, root, astIndex);
    expect(result.content[0].text).toContain("MODULE ROUTE: apps/api → db");
    expect(result.content[0].text).toContain("apps/api → core → db");
  });

  it("passes machine formats through without a header (mermaid)", async () => {
    const diagram = "graph TD\n  api --> db";
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      moduleRoute: async () => diagram,
    } as any;
    const result = await handleModuleRoute(
      { from: "api", to: "db", format: "mermaid" },
      root,
      astIndex,
    );
    expect(result.content[0].text).toBe(diagram);
    expect(result.content[0].text).not.toContain("MODULE ROUTE:");
  });

  it("reports a clean no-path message on empty output", async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      moduleRoute: async () => "   ",
    } as any;
    const result = await handleModuleRoute(
      { from: "a", to: "b", maxDepth: 8 },
      root,
      astIndex,
    );
    expect(result.content[0].text).toContain("No dependency path returned");
    expect(result.content[0].text).toContain("within 8 hops");
    expect(result.content[0].text).toContain("ast-index rebuild");
  });

  it("surfaces a failure hint when the client returns null", async () => {
    const astIndex = {
      isDisabled: () => false,
      isOversized: () => false,
      moduleRoute: async () => null,
    } as any;
    const result = await handleModuleRoute({ from: "a", to: "b" }, root, astIndex);
    expect(result.content[0].text).toContain("module-route failed");
  });
});

describe("validateModuleRouteArgs", () => {
  it("requires from and to", () => {
    expect(() => validateModuleRouteArgs({ to: "b" })).toThrow(/"from"/);
    expect(() => validateModuleRouteArgs({ from: "a" })).toThrow(/"to"/);
  });

  it("rejects an invalid viaKind / format", () => {
    expect(() => validateModuleRouteArgs({ from: "a", to: "b", viaKind: "weird" })).toThrow(
      /viaKind/,
    );
    expect(() => validateModuleRouteArgs({ from: "a", to: "b", format: "yaml" })).toThrow(
      /format/,
    );
  });

  it("clamps numeric caps to safe ceilings", () => {
    const out = validateModuleRouteArgs({
      from: "a",
      to: "b",
      maxPaths: 9999,
      maxDepth: 9999,
    });
    expect(out.maxPaths).toBe(200);
    expect(out.maxDepth).toBe(50);
  });

  it("defaults all to false and passes through valid values", () => {
    const out = validateModuleRouteArgs({
      from: "a",
      to: "b",
      all: true,
      viaKind: "api",
      format: "dot",
    });
    expect(out).toEqual({
      from: "a",
      to: "b",
      all: true,
      maxPaths: undefined,
      maxDepth: undefined,
      viaKind: "api",
      format: "dot",
    });
  });
});
