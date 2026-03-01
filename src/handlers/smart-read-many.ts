import type { AstIndexClient } from '../ast-index/client.js';
import type { FileCache } from '../core/file-cache.js';
import type { ContextRegistry } from '../core/context-registry.js';
import type { TokenPilotConfig } from '../types.js';
import { handleSmartRead } from './smart-read.js';

export interface SmartReadManyArgs {
  paths: string[];
}

export async function handleSmartReadMany(
  args: SmartReadManyArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
  fileCache: FileCache,
  contextRegistry: ContextRegistry,
  config: TokenPilotConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.paths || args.paths.length === 0) {
    return {
      content: [{ type: 'text', text: 'No paths provided.' }],

    };
  }

  if (args.paths.length > 20) {
    return {
      content: [{ type: 'text', text: `Too many files (${args.paths.length}). Maximum is 20 per batch.` }],
    };
  }

  const results: string[] = [];
  let totalTokens = 0;

  for (const path of args.paths) {
    try {
      const result = await handleSmartRead(
        { path },
        projectRoot,
        astIndex,
        fileCache,
        contextRegistry,
        config,
      );
      const text = result.content[0]?.text ?? '';
      results.push(text);
      // Rough count from output length
      totalTokens += Math.ceil(text.length / 4);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`FILE: ${path}\nERROR: ${msg}`);
    }
  }

  results.push('');
  results.push(`BATCH: ${args.paths.length} files loaded (~${totalTokens} tokens total)`);

  return { content: [{ type: 'text', text: results.join('\n\n---\n\n') }] };
}
