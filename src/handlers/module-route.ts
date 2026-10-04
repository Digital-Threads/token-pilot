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

  const opts = {
    from: args.from,
    to: args.to,
    all: args.all,
    maxPaths: args.maxPaths,
    maxDepth: args.maxDepth,
    viaKind: args.viaKind,
  };
  const header = `MODULE ROUTE: ${args.from} → ${args.to}`;
  const failed = {
    content: [
      {
        type: "text" as const,
        text:
          `${header}\n\n` +
          "⚠ module-route failed (index unavailable or command error).\n" +
          "HINT: run `npx token-pilot doctor` to check ast-index, or fall back to module_info().",
      },
    ],
    meta: { files: [] },
  };
  const isMachineFormat =
    args.format === "json" || args.format === "mermaid" || args.format === "dot";

  // json first: only it says why a route is empty (`empty_reason`) — the
  // text form says "run ast-index rebuild" for every case, mermaid/dot too.
  const json = await astIndex.moduleRoute({ ...opts, format: "json" });
  if (json == null) return failed;

  let route: RouteJson | null = null;
  try {
    route = JSON.parse(json) as RouteJson;
  } catch {
    route = null; // binary without json for module-route
  }

  if (route && (route.paths?.length ?? 0) === 0) {
    const reason = await explainEmpty(route.empty_reason, args, astIndex);
    const text =
      args.format === "json"
        ? json.trim()
        : args.format === "mermaid"
          ? `\`\`\`mermaid\nflowchart LR\n  %% No path: ${oneLine(reason)}\n\`\`\``
          : args.format === "dot"
            ? `digraph module_route {\n  // No path: ${oneLine(reason)}\n}`
            : `${header}\n\n${reason}`;
    return { content: [{ type: "text", text }], meta: { files: [] } };
  }

  const output =
    route && args.format === "json"
      ? json
      : await astIndex.moduleRoute({ ...opts, format: args.format });
  if (output == null) return failed;

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
            "Either the modules are unrelated, a module name is wrong (module_info() lists them), " +
            "or this project has no module graph — ast-index builds one only for multi-module builds.",
        },
      ],
      meta: { files: [] },
    };
  }

  // For machine formats (json/mermaid/dot) pass the payload through clean —
  // a header would corrupt a diagram/parse. Text format gets the header.
  const more = route?.truncated
    ? `\n\nmore paths exist than shown — raise maxPaths or set all=true.`
    : "";
  const text = isMachineFormat ? body : `${header}\n\n${body}${more}`;

  return {
    content: [{ type: "text", text }],
    meta: { files: [] },
  };
}

interface RouteJson {
  paths?: unknown[];
  count?: number;
  truncated?: boolean;
  empty_reason?: string;
}

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

/** Why `module-route` found no path, in words that lead to the right next step. */
async function explainEmpty(
  reason: string | undefined,
  args: ModuleRouteArgs,
  astIndex: AstIndexClient,
): Promise<string> {
  const listModules = async () => {
    const all = await astIndex.modules("");
    if (all.length === 0) return "";
    const names = all.slice(0, 20).map((m) => m.name).join(", ");
    return `\nAvailable modules (${all.length}): ${names}${all.length > 20 ? ", …" : ""}`;
  };

  switch (reason) {
    case "not_indexed": {
      const modules = await astIndex.modules("");
      return modules.length === 0
        ? "ast-index found no modules in this project — it builds a module graph only for multi-module builds (Gradle, Maven, Cargo, …). Use related_files() for file-level imports."
        : "The modules are indexed but their dependency graph is not — the index was built without it. A full `ast-index rebuild` (without --no-deps) adds it.";
    }
    case "missing_module_from":
      return `Module "${args.from}" is not in the index.${await listModules()}`;
    case "missing_module_to":
      return `Module "${args.to}" is not in the index.${await listModules()}`;
    case "unreachable":
      return `"${args.from}" does not depend on "${args.to}" — no path within ${args.maxDepth ?? 20} hops${args.viaKind ? ` via ${args.viaKind}` : ""}.`;
    default:
      return `No dependency path from "${args.from}" to "${args.to}"${reason ? ` (${reason})` : ""}.`;
  }
}
