import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TokenPilotConfig } from '../types.js';
import { DEFAULT_CONFIG } from './defaults.js';

export async function loadConfig(projectRoot: string): Promise<TokenPilotConfig> {
  const configPath = resolve(projectRoot, '.token-pilot.json');

  try {
    const raw = await readFile(configPath, 'utf-8');
    const userConfig = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_CONFIG), userConfig) as TokenPilotConfig;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}
