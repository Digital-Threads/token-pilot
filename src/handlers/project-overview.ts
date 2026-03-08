import { basename } from 'node:path';
import type { AstIndexClient } from '../ast-index/client.js';
import { detectProject } from '../core/project-detector.js';
import type { ProjectDetection, DetectedStack } from '../core/project-detector.js';
import type { ProjectOverviewArgs } from '../core/validation.js';

export async function handleProjectOverview(
  args: ProjectOverviewArgs,
  projectRoot: string,
  astIndex: AstIndexClient,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const lines: string[] = [];

  // 1. Dual detection: ast-index + config scanner
  let astIndexType: string | undefined;
  let mapData: Awaited<ReturnType<AstIndexClient['map']>> | null = null;
  let convData: Awaited<ReturnType<AstIndexClient['conventions']>> | null = null;

  if (astIndex.isAvailable() && !astIndex.isOversized() && !astIndex.isDisabled()) {
    [mapData, convData] = await Promise.all([
      astIndex.map(),
      astIndex.conventions(),
    ]);
    if (mapData) {
      astIndexType = mapData.project_type;
    }
  }

  const detection = await detectProject(projectRoot, astIndexType);

  // Determine which sections to include
  const include = args.include ?? ['stack', 'ci', 'quality', 'architecture'];
  const showStack = include.includes('stack');
  const showCI = include.includes('ci');
  const showQuality = include.includes('quality');
  const showArch = include.includes('architecture');

  // 2. Project identity
  lines.push(`PROJECT: ${detection.projectName} v${detection.projectVersion}`);
  if (detection.projectDescription) lines.push(`  ${detection.projectDescription}`);
  lines.push('');

  // 3. TYPE — dual detection
  if (showStack) {
    if (astIndexType) {
      lines.push(`TYPE (ast-index): ${astIndexType}${mapData ? ` (${mapData.file_count} files)` : ''}`);
    }

    if (detection.configStacks.length > 0) {
      const configLine = formatConfigStacks(detection);
      lines.push(`TYPE (config): ${configLine}`);
    }

    if (detection.configStacks.length === 0 && !astIndexType) {
      lines.push('TYPE: unknown (no config files found)');
    }

    // Confidence
    lines.push(`CONFIDENCE: ${detection.confidence}${getConfidenceHint(detection)}`);
    lines.push('');
  }

  // 4. Architecture & frameworks (from ast-index conventions)
  if (showArch && convData) {
    if (convData.architecture.length > 0) {
      lines.push(`ARCHITECTURE: ${convData.architecture.join(', ')}`);
    }

    // Merge framework info: ast-index conventions + config detection
    const fwList = buildFrameworkList(convData, detection);
    if (fwList.length > 0) {
      lines.push(`FRAMEWORKS: ${fwList.join(', ')}`);
    }

    if (convData.naming_patterns.length > 0) {
      const patterns = convData.naming_patterns
        .slice(0, 8)
        .map(p => `${p.suffix}(${p.count})`)
        .join(', ');
      lines.push(`PATTERNS: ${patterns}`);
    }
    lines.push('');
  }

  // 5. Quality tools
  if (showQuality && detection.qualityTools.length > 0) {
    lines.push(`QUALITY: ${detection.qualityTools.join(', ')}`);
  }

  // 6. CI pipelines
  if (showCI && detection.ciPipelines.length > 0) {
    lines.push(`CI: ${detection.ciPipelines.join(', ')}`);
  }

  // Docker
  if (showCI && detection.hasDocker) {
    lines.push('DOCKER: yes');
  }

  if ((showQuality && detection.qualityTools.length > 0) || (showCI && detection.ciPipelines.length > 0)) {
    lines.push('');
  }

  // 7. Directory map (from ast-index)
  if (showArch && mapData) {
    lines.push('MAP:');
    for (const group of mapData.groups) {
      const kinds = group.kinds
        ? ' — ' + Object.entries(group.kinds).map(([k, v]) => `${v} ${k}`).join(', ')
        : '';
      lines.push(`  ${group.path} (${group.file_count} files${kinds})`);
    }
    lines.push('');
  } else if (showArch && !mapData && astIndex.isAvailable() && !astIndex.isDisabled() && !astIndex.isOversized()) {
    // Fallback to stats
    try {
      const statsText = await astIndex.stats();
      if (statsText) {
        const filesMatch = statsText.match(/Files:\s*(\d+)/);
        const symbolsMatch = statsText.match(/Symbols:\s*(\d+)/);
        if (filesMatch) lines.push(`Files indexed: ${filesMatch[1]}`);
        if (symbolsMatch) lines.push(`Symbols: ${symbolsMatch[1]}`);
        lines.push('');
      }
    } catch { /* ignore */ }
  }

  // 8. Degradation warnings
  if (astIndex.isDisabled()) {
    lines.push('⚠ ast-index: project root not detected. Call smart_read() on any project file first.');
    lines.push('  Working tools: smart_read, smart_read_many, outline, read_symbol, read_range');
    lines.push('  After smart_read: find_unused, find_usages, related_files, project map');
    lines.push('');
  } else if (astIndex.isOversized()) {
    lines.push('⚠ ast-index disabled: >50k files indexed (node_modules leak). Ensure node_modules is in .gitignore.');
    lines.push('  Working tools: smart_read, smart_read_many, outline, read_symbol, read_range');
    lines.push('  Disabled tools: find_unused, find_usages, related_files');
    lines.push('');
  }

  lines.push('HINT: Use smart_read() on files, find_usages() for symbol references, outline() for directory overview.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ──────────────────────────────────────────────
// Formatters
// ──────────────────────────────────────────────

function formatConfigStacks(detection: ProjectDetection): string {
  if (detection.configStacks.length === 0) return 'unknown';

  const parts: string[] = [];
  for (const stack of detection.configStacks) {
    let part = stack.type;
    if (stack.langVersion) part = stack.langVersion;
    if (stack.framework) part += ` (${stack.framework})`;
    parts.push(part);
  }

  if (detection.primaryStack && detection.configStacks.length > 1) {
    // Put primary first, mark others
    const primaryIdx = detection.configStacks.indexOf(detection.primaryStack);
    if (primaryIdx > 0) {
      const [primary] = parts.splice(primaryIdx, 1);
      parts.unshift(primary);
    }
    return parts[0] + (parts.length > 1 ? ` + ${parts.slice(1).join(', ')}` : '');
  }

  return parts.join(', ');
}

function getConfidenceHint(detection: ProjectDetection): string {
  if (detection.confidence === 'low') {
    return ` — ast-index and config files disagree on project type`;
  }
  if (detection.confidence === 'medium' && detection.configStacks.length > 1) {
    return ` — multi-stack project detected`;
  }
  return '';
}

function buildFrameworkList(
  convData: { frameworks: Record<string, Array<{ name: string; count: number }>> },
  detection: ProjectDetection,
): string[] {
  const fwSet = new Set<string>();

  // From ast-index conventions
  for (const [category, frameworks] of Object.entries(convData.frameworks)) {
    for (const fw of frameworks) {
      fwSet.add(`${fw.name} (${category})`);
    }
  }

  // From config detection (may have version info that conventions don't)
  for (const stack of detection.configStacks) {
    if (stack.framework && !Array.from(fwSet).some(f => f.includes(stack.framework!.split(' ')[0]))) {
      fwSet.add(stack.framework);
    }
  }

  return Array.from(fwSet);
}
