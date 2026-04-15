/**
 * MCP tool definitions and system instructions.
 * Pure static data — no runtime dependencies.
 */

export const MCP_INSTRUCTIONS = [
  'Token Pilot — token-efficient code reading (saves 60-80% tokens). ALWAYS prefer these tools over Read/cat/grep.',
  '',
  'DECISION RULES — pick the first match:',
  '1. New codebase / unfamiliar project → project_overview',
  '2. Starting work on a directory → explore_area (outline + imports + tests + git log in one call)',
  '3. Need to read a code file → smart_read (NOT Read/cat — returns structure, 60-80% fewer tokens)',
  '   - For navigation/browsing: smart_read(scope="nav") — names + lines only, 2-3x smaller',
  '   - For public API overview: smart_read(scope="exports")',
  '4. Need one function/class body → read_symbol (loads only that symbol, NOT the whole file)',
  '   - Preparing edit? Add include_edit_context=true to skip separate read_for_edit call',
  '5. Need MULTIPLE function/class bodies from same file → read_symbols (batch — one call instead of N)',
  '6. Preparing an edit → read_for_edit (returns exact text for Edit old_string)',
  '7. Verify edits after editing → read_diff (only changed hunks — REQUIRES smart_read BEFORE editing)',
  '8. Multiple files at once → smart_read_many (batch up to 20 files)',
  '9. Find where a symbol is used → find_usages (semantic: definitions + imports + usages)',
  '   - For initial discovery: find_usages(mode="list") — file:line only, 5-10x smaller',
  '10. Understand file dependencies → related_files (imports, importers, tests — ranked by relevance)',
  '11. List all symbols in a directory → outline (classes, functions, methods in one call)',
  '12. Review git changes → smart_diff (NOT git diff — maps changes to functions/classes)',
  '13. Commit history → smart_log (NOT git log — structured with categories)',
  '14. Run tests → test_summary (NOT raw test output — structured pass/fail)',
  '15. Code quality → code_audit (TODOs, deprecated, structural patterns)',
  '16. Dead code → find_unused (unreferenced symbols across project)',
  '17. Module architecture → module_info (deps, dependents, public API)',
  '18. Read markdown/yaml/json/csv section → read_section (loads one heading/key/row-range, NOT the whole file)',
  '   - For editing sections: read_for_edit(path, section="Section Name")',
  '19. Long session / before compaction → session_snapshot (capture goal, decisions, confirmed facts, files, next step as <200 token block)',
  '   - Budget-constrained? Use smart_read(max_tokens=N) to auto-downgrade output size',
  '',
  'USE DEFAULT TOOLS ONLY FOR: regex text search → Grep | exact raw content → Read | non-code configs → Read',
  '',
  'WORKFLOWS:',
  '• Explore: project_overview → explore_area → smart_read → read_symbol',
  '• Edit: smart_read → read_symbol(include_edit_context=true) → Edit → read_diff',
  '• Docs: smart_read (outline) → read_section → read_for_edit(section=) → Edit → read_diff',
  '• Refactor: find_usages → read_symbols → read_for_edit → Edit → test_summary',
  '• Audit: code_audit + find_unused + Grep (for regex patterns)',
  '• Long session: session_snapshot → compact context → continue with minimal state',
].join('\n');

export const TOOL_DEFINITIONS = [
  // --- Core reading tools ---
  {
    name: 'smart_read',
    description: 'Use INSTEAD OF Read/cat for code files. Returns code structure (classes, functions, methods with signatures and line ranges) — 60-80% fewer tokens than raw content. Use read_symbol() to drill into specific code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (absolute or relative to project root)' },
        show_imports: { type: 'boolean', description: 'Include import details (default: true)' },
        show_docs: { type: 'boolean', description: 'Include doc comments (default: true)' },
        depth: { type: 'number', description: 'Max depth for nested symbols (default: 2)' },
        scope: {
          type: 'string',
          enum: ['full', 'nav', 'exports'],
          description: 'Output scope: full (default, all details), nav (names + lines only, 2-3x smaller), exports (public API only)',
        },
        max_tokens: { type: 'number', description: 'Token budget. If output exceeds this, auto-downgrades: full → outline → compact. Use for context-constrained sessions.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_symbol',
    description: 'Read source code of ONE specific function/method/class — INSTEAD OF reading the whole file. Supports Class.method syntax.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        symbol: { type: 'string', description: 'Symbol name, e.g. "UserService.updateUser"' },
        context_before: { type: 'number', description: 'Lines of context before (default: 2)' },
        context_after: { type: 'number', description: 'Lines of context after (default: 0)' },
        show: { type: 'string', enum: ['full', 'head', 'tail', 'outline'], description: 'Display mode: full (all lines), head (first 50), tail (last 30), outline (head + methods + tail). Default: auto (full ≤300 lines, outline >300)' },
        include_edit_context: {
          type: 'boolean',
          description: 'Append raw code block for Edit old_string (saves a read_for_edit call)',
        },
      },
      required: ['path', 'symbol'],
    },
  },
  {
    name: 'read_symbols',
    description: 'Batch read MULTIPLE symbols from ONE file for UNDERSTANDING code — saves N-1 round-trips vs calling read_symbol N times. Returns formatted symbol bodies with show modes (full/head/tail/outline). Use this when READING code, not editing. For edit preparation use read_for_edit instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of symbol names (max 10), e.g. ["UserService.create", "UserService.update", "UserService.delete"]',
        },
        context_before: { type: 'number', description: 'Lines of context before each symbol (default: 2)' },
        context_after: { type: 'number', description: 'Lines of context after each symbol (default: 0)' },
        show: { type: 'string', enum: ['full', 'head', 'tail', 'outline'], description: 'Display mode for each symbol (default: auto)' },
      },
      required: ['path', 'symbols'],
    },
  },
  {
    name: 'read_range',
    description: 'Read a specific line range from a file. Use when you know exact lines — lighter than reading the whole file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'number', description: 'Start line (1-indexed)' },
        end_line: { type: 'number', description: 'End line (1-indexed, inclusive)' },
      },
      required: ['path', 'start_line', 'end_line'],
    },
  },
  {
    name: 'read_section',
    description: 'Read a specific section from Markdown, YAML, JSON, or CSV files. Markdown: by heading name. YAML/JSON: by top-level key. CSV: by row range (rows:1-50). Much cheaper than reading the whole file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to .md, .yaml, .yml, .json, or .csv file' },
        heading: { type: 'string', description: 'Section heading (Markdown), top-level key (YAML/JSON), or row range "rows:1-50" (CSV). Case-insensitive.' },
      },
      required: ['path', 'heading'],
    },
  },
  {
    name: 'read_diff',
    description: 'Use INSTEAD OF re-reading whole file after edits. Shows only changed hunks. REQUIRES: call smart_read or read_for_edit BEFORE editing to create baseline snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        context_lines: { type: 'number', description: 'Lines of context around changes (default: 3)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_for_edit',
    description: 'Use INSTEAD OF Read when preparing an EDIT. Returns exact RAW code around a symbol or line — copy directly as old_string for Edit tool. Supports batch: pass "symbols" array to get multiple edit contexts in one call. Unlike read_symbols (for reading/understanding), this returns unformatted code optimized for copy-paste into Edit. Optional: include_callers, include_tests, include_changes for enriched context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        symbol: { type: 'string', description: 'Symbol name to edit (e.g. "UserService.updateUser")' },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of symbol names for batch edit context (max 10). Alternative to single "symbol" — returns all symbols in one call.',
        },
        line: { type: 'number', description: 'Line number to edit (alternative to symbol)' },
        context: { type: 'number', description: 'Lines of context around target (default: 5)' },
        include_callers: { type: 'boolean', description: 'Show top callers of this symbol (saves a separate find_usages call)' },
        include_tests: { type: 'boolean', description: 'Show related test file and test names' },
        include_changes: { type: 'boolean', description: 'Show recent git changes in the target region' },
        section: {
          type: 'string',
          description: 'Section to edit: heading (Markdown), top-level key (YAML/JSON), or "rows:1-50" (CSV). Returns raw section content for Edit old_string.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'smart_read_many',
    description: 'Batch smart_read for multiple files at once — INSTEAD OF calling Read on each file. Returns structure for each file. Max 20 files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file paths',
        },
        max_tokens: { type: 'number', description: 'Token budget per file. If a file exceeds this, auto-downgrades to compact outline.' },
      },
      required: ['paths'],
    },
  },
  // --- Search & navigation ---
  {
    name: 'find_usages',
    description: 'Use INSTEAD OF Grep for finding symbol references. Semantic search — groups by: definitions, imports, usages. Supports scope, kind, limit, lang filters. Use context_lines to include surrounding code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name to find usages of' },
        scope: { type: 'string', description: 'Filter results by path prefix (e.g., "src/Domain/")' },
        kind: { type: 'string', enum: ['definitions', 'imports', 'usages', 'all'], description: 'Show only specific section (default: "all")' },
        limit: { type: 'number', description: 'Max results per category (default: 50, max: 500)' },
        lang: { type: 'string', description: 'Filter by language/extension (e.g., "php", "typescript")' },
        context_lines: { type: 'number', description: 'Lines of source context around each match (0-10). When set, shows surrounding code — saves follow-up read_symbol calls.' },
        mode: {
          type: 'string',
          enum: ['full', 'list'],
          description: 'Output mode: full (with context, default), list (file:line only, 5-10x smaller for initial discovery)',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'project_overview',
    description: 'START HERE for unfamiliar codebases. Shows project type, architecture, framework detection, quality tools, CI, directory map. Use include filter for specific sections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: ['stack', 'ci', 'quality', 'architecture'] },
          description: 'Sections to include (default: all). Use ["stack"] for quick type check, ["quality","ci"] for tooling overview.',
        },
      },
    },
  },
  {
    name: 'related_files',
    description: 'Show ranked import graph for a file: imports, importers, and tests scored by relevance (test adjacency, import closeness, recent changes, path proximity). Files ranked into HIGH VALUE / MEDIUM / LOW to prioritize reading.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to analyze' },
      },
      required: ['path'],
    },
  },
  {
    name: 'outline',
    description: 'Use INSTEAD OF listing dir + reading each file. One call returns all symbols (classes, functions, methods, routes) for every code file in a directory. Supports recursive with max_depth.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path' },
        recursive: { type: 'boolean', description: 'Recursively outline subdirectories (default: false)' },
        max_depth: { type: 'number', description: 'Max recursion depth when recursive=true (default: 2, max: 5)' },
      },
      required: ['path'],
    },
  },
  // --- Analytics ---
  {
    name: 'session_analytics',
    description: 'Show token savings report: calls, tokens saved, per-tool breakdown, top files, cache hits. Use verbose=true for full breakdown (per-intent, decision insights, savings by category).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        verbose: { type: 'boolean', description: 'Show detailed breakdown: per-intent, savings by category, decision insights (default: false)' },
      },
    },
  },
  // --- Analysis ---
  {
    name: 'find_unused',
    description: 'Find dead code — functions, classes, and variables with no references across the project. Use for cleanup and refactoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        module: { type: 'string', description: 'Filter by module path (e.g., "src/services/")' },
        export_only: { type: 'boolean', description: 'Only check exported (capitalized) symbols' },
        limit: { type: 'number', description: 'Max results (default: 30)' },
      },
    },
  },
  {
    name: 'code_audit',
    description: 'Find code quality issues: TODO/FIXME comments, deprecated symbols, structural code patterns (bare except:, print() calls). Use for project-wide audits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        check: {
          type: 'string',
          enum: ['pattern', 'todo', 'deprecated', 'annotations', 'all'],
          description: 'What to check: "pattern" (structural search via ast-grep, e.g. "except:", "print($$$ARGS)"), "todo" (TODO/FIXME comments), "deprecated" (deprecated symbols), "annotations" (find by decorator name), "all" (todo + deprecated summary)',
        },
        pattern: { type: 'string', description: 'Code pattern for check="pattern". ast-grep syntax: "except:" finds bare excepts, "print($$$ARGS)" finds print calls.' },
        name: { type: 'string', description: 'Decorator/annotation name for check="annotations". Example: "Deprecated", "Controller"' },
        lang: { type: 'string', description: 'Language filter for check="pattern" (e.g., "python", "typescript")' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['check'],
    },
  },
  {
    name: 'module_info',
    description: 'Analyze module dependencies, dependents, public API, and unused deps. Use for architecture understanding and dependency cleanup.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        module: { type: 'string', description: 'Module name or path pattern (e.g., "auth", "src/Domain/")' },
        check: {
          type: 'string',
          enum: ['deps', 'dependents', 'api', 'unused-deps', 'all'],
          description: 'What to check: "deps" (dependencies), "dependents" (who depends on this), "api" (public symbols), "unused-deps" (dead dependencies), "all" (everything). Default: "all"',
        },
      },
      required: ['module'],
    },
  },
  // --- Diff & exploration ---
  {
    name: 'smart_diff',
    description: 'Use INSTEAD OF raw git diff. Shows changed files with AST symbol mapping — which functions/classes were modified/added/removed. Small diffs include hunks, large diffs show summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['unstaged', 'staged', 'commit', 'branch'], description: 'Diff scope (default: "unstaged")' },
        path: { type: 'string', description: 'Filter to specific file or directory' },
        ref: { type: 'string', description: 'Git ref — required for scope="commit" (commit hash) or scope="branch" (branch name)' },
      },
    },
  },
  {
    name: 'explore_area',
    description: 'One-call exploration of a directory: outline (all symbols), imports (external deps + who imports this area), tests (matching test files), recent git changes. Use INSTEAD OF separate outline + related_files + git log calls.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path (or file path — will use its parent directory)' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['outline', 'imports', 'tests', 'changes'] },
          description: 'Sections to include (default: all)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'smart_log',
    description: 'Use INSTEAD OF raw git log. Structured commit history with category detection (feat/fix/refactor/docs), file stats, author breakdown. Filters by path and ref.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Filter to specific file or directory' },
        count: { type: 'number', description: 'Number of commits (default: 10, max: 50)' },
        ref: { type: 'string', description: 'Git ref — branch, tag, or commit (default: HEAD)' },
      },
    },
  },
  {
    name: 'test_summary',
    description: 'Run tests and return structured summary: total/passed/failed/skipped + failure details. 200 lines of raw output → 10-15 lines. Supports vitest, jest, pytest, phpunit, go test, cargo test.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Test command to run (e.g., "npm test", "pytest", "go test ./...")' },
        runner: { type: 'string', enum: ['vitest', 'jest', 'pytest', 'phpunit', 'go', 'cargo', 'rspec', 'mocha'], description: 'Force specific parser (auto-detected if omitted)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 60000, max: 300000)' },
      },
      required: ['command'],
    },
  },
  // --- Session ---
  {
    name: 'session_snapshot',
    description: 'Capture current session state as a compact markdown block (<200 tokens). Call before compaction, when switching direction, or periodically in long sessions. Model provides the facts, tool formats them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        goal: { type: 'string', description: 'Session goal — what and why' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Key decisions made and why (e.g., "removed sysfee step — caused double counting"). Prevents revisiting rejected approaches.' },
        confirmed: { type: 'array', items: { type: 'string' }, description: 'Established facts (what has been verified)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths' },
        blocked: { type: 'string', description: 'Current blocker or obstacle' },
        next: { type: 'string', description: 'Next step to take' },
      },
      required: ['goal'],
    },
  },
];
