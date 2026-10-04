/**
 * Config resolution without file or process access, so the CLI hooks and
 * the Claude Code mod apply the same defaults, migrations and overrides.
 */
import { describe, it, expect } from "vitest";
import { resolveConfig } from "../../src/config/resolve.ts";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";

describe("resolveConfig", () => {
  it("applies env overrides from the env it is given", () => {
    expect(
      resolveConfig({}, { TOKEN_PILOT_DENY_THRESHOLD: "120" }).hooks.denyThreshold,
    ).toBe(120);
  });

  it("falls back to the default mode on an unknown one and warns", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ hooks: { mode: "nope" } }, {}, (m) => warnings.push(m));

    expect(config.hooks.mode).toBe(DEFAULT_CONFIG.hooks.mode);
    expect(warnings[0]).toContain('Unknown hooks.mode "nope"');
  });

  it("returns a copy, never the shared defaults object", () => {
    const config = resolveConfig(null, {});
    config.hooks.denyThreshold = 1;

    expect(DEFAULT_CONFIG.hooks.denyThreshold).not.toBe(1);
  });
});
