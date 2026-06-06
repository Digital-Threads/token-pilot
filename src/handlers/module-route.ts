import type { AstIndexClient } from "../ast-index/client.js";
import type { ModuleRouteArgs } from "../core/validation.js";

/**
 * module_route — transitive dependency path(s) between two modules.
 *
 * Thin wrapper over ast-index 3.44 `module-route`. The CLI already
 * produces compact, purpose-built output (a path listing, or
 * mermaid/dot/json for diagramming), so the handler only frames it and
 * handles the empty / degraded cases — it does not re-parse the graph.
 */
export async function handleModuleRoute(
  args: ModuleRouteArgs,
  _projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: "text"; text: string }>; meta: { files: string[] } }> {
  // Degradation check — same contract as module_info.
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [
        {
          type: "text",
          text:
            "⚠ ast-index unavailable — module_route requires ast-index.\n" +
            "DEGRADED: Use module_info() on each module + related_files() to trace dependencies manually.",
        },
      ],
      meta: { files: [] },
    };
  }

  const output = await astIndex.moduleRoute({
    from: args.from,
    to: args.to,
    all: args.all,
    maxPaths: args.maxPaths,
    maxDepth: args.maxDepth,
    viaKind: args.viaKind,
    format: args.format,
  });

  const header = `MODULE ROUTE: ${args.from} → ${args.to}`;

  if (output == null) {
    return {
      content: [
        {
          type: "text",
          text:
            `${header}\n\n` +
            "⚠ module-route failed (index unavailable or command error).\n" +
            "HINT: run `npx token-pilot doctor` to check ast-index, or fall back to module_info().",
        },
      ],
      meta: { files: [] },
    };
  }

  const body = output.trim();

  if (body.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            `${header}\n\n` +
            `No dependency path returned from "${args.from}" to "${args.to}" ` +
            `(within ${args.maxDepth ?? 20} hops).\n` +
            "This means one of:\n" +
            "  • the modules are genuinely unrelated, or\n" +
            "  • the module-dependency graph isn't indexed yet — run `ast-index rebuild`.\n" +
            'HINT: also try a higher "maxDepth" / wider "viaKind", or module_info() to confirm each module resolves.',
        },
      ],
      meta: { files: [] },
    };
  }

  // For machine formats (json/mermaid/dot) pass the payload through clean —
  // a header would corrupt a diagram/parse. Text format gets the header.
  const isMachineFormat =
    args.format === "json" || args.format === "mermaid" || args.format === "dot";

  const text = isMachineFormat ? body : `${header}\n\n${body}`;

  return {
    content: [{ type: "text", text }],
    meta: { files: [] },
  };
}
