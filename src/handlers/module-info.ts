import { relative } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import type { ModuleInfoArgs } from '../core/validation.js';

export async function handleModuleInfo(
  args: ModuleInfoArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Degradation check
  if (astIndex.isDisabled() || astIndex.isOversized()) {
    return {
      content: [{
        type: 'text',
        text: '⚠ ast-index unavailable — module_info requires ast-index.\n' +
              'DEGRADED: Use find_usages() + related_files() as alternatives for dependency analysis.',
      }],
    };
  }

  const check = args.check ?? 'all';
  const sections: string[] = [];

  // Resolve module
  const moduleList = await astIndex.modules(args.module);
  const moduleName = moduleList.length > 0 ? moduleList[0].name : args.module;
  const modulePath = moduleList.length > 0 ? moduleList[0].path : args.module;

  sections.push(`MODULE: ${moduleName} (${modulePath})`);

  if (moduleList.length === 0) {
    sections.push('');
    sections.push(`⚠ Module "${args.module}" not found by ast-index.`);
    sections.push('');

    // List available modules as hint
    const allModules = await astIndex.modules();
    if (allModules.length > 0) {
      sections.push(`Available modules (${allModules.length}):`);
      for (const m of allModules.slice(0, 20)) {
        sections.push(`  ${m.name} (${m.path})`);
      }
      if (allModules.length > 20) {
        sections.push(`  ... and ${allModules.length - 20} more`);
      }
    } else {
      sections.push('No modules detected. ast-index module analysis requires a modular project structure.');
      sections.push('HINT: Use find_usages() for cross-file symbol references, related_files() for import graphs.');
    }

    return { content: [{ type: 'text', text: sections.join('\n') }] };
  }

  sections.push('');

  // Run requested checks in parallel
  const checks = check === 'all'
    ? (['deps', 'dependents', 'api', 'unused-deps'] as const)
    : ([check] as const);

  const results = await Promise.allSettled(
    checks.map(async (c) => {
      switch (c) {
        case 'deps': return { type: 'deps' as const, data: await astIndex.moduleDeps(args.module) };
        case 'dependents': return { type: 'dependents' as const, data: await astIndex.moduleDependents(args.module) };
        case 'api': return { type: 'api' as const, data: await astIndex.moduleApi(args.module) };
        case 'unused-deps': return { type: 'unused-deps' as const, data: await astIndex.unusedDeps(args.module) };
      }
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { type, data } = r.value;

    switch (type) {
      case 'deps': {
        if (data.length > 0) {
          sections.push(`DEPENDENCIES (${data.length}):`);
          for (const d of data) {
            const typeHint = d.type ? ` [${d.type}]` : '';
            sections.push(`  → ${d.name} (${d.path})${typeHint}`);
          }
        } else {
          sections.push('DEPENDENCIES: none detected');
        }
        sections.push('');
        break;
      }

      case 'dependents': {
        if (data.length > 0) {
          sections.push(`DEPENDENTS (${data.length} modules depend on this):`);
          for (const d of data) {
            sections.push(`  ← ${d.name} (${d.path})`);
          }
        } else {
          sections.push('DEPENDENTS: none — this module is a leaf');
        }
        sections.push('');
        break;
      }

      case 'api': {
        if (data.length > 0) {
          sections.push(`PUBLIC API (${data.length} symbols):`);
          for (const a of data) {
            const loc = `${rel(projectRoot, a.file)}:${a.line}`;
            const sig = a.signature ? ` — ${a.signature}` : '';
            sections.push(`  ${a.kind} ${a.name}${sig}  (${loc})`);
          }
        } else {
          sections.push('PUBLIC API: none detected');
        }
        sections.push('');
        break;
      }

      case 'unused-deps': {
        if (data.length > 0) {
          sections.push(`UNUSED DEPENDENCIES (${data.length}):`);
          for (const d of data) {
            const reason = d.reason ? ` — ${d.reason}` : ' — imported but no symbols used';
            sections.push(`  ⚠ ${d.name} (${d.path})${reason}`);
          }
        } else {
          sections.push('UNUSED DEPENDENCIES: none — all dependencies are used');
        }
        sections.push('');
        break;
      }
    }
  }

  sections.push('HINT: Use smart_read() on module files, find_usages() for cross-module references.');

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

function rel(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath) || absPath;
}
