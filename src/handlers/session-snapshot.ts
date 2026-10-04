export interface SessionSnapshotArgs {
  goal: string;
  decisions?: string[];
  confirmed?: string[];
  files?: string[];
  blocked?: string;
  next?: string;
}

/** A list field: an array of strings, or one string taken as one item. */
function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value;
  throw new Error(`"${field}" must be an array of strings.`);
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new Error(`"${field}" must be a string.`);
}

export function handleSessionSnapshot(args: SessionSnapshotArgs): { content: { type: 'text'; text: string }[] } {
  const goal = text(args.goal, 'goal');
  if (!goal) throw new Error('"goal" is required and must be a string.');

  const decisions = list(args.decisions, 'decisions');
  const confirmed = list(args.confirmed, 'confirmed');
  const files = list(args.files, 'files');
  const blocked = text(args.blocked, 'blocked');
  const next = text(args.next, 'next');

  const lines: string[] = ['## Session State'];

  lines.push(`**Goal:** ${goal}`);

  if (decisions.length) {
    lines.push('**Decisions:**');
    for (const item of decisions) {
      lines.push(`- ${item}`);
    }
  }

  if (confirmed.length) {
    lines.push('**Confirmed:**');
    for (const item of confirmed) {
      lines.push(`- ${item}`);
    }
  }

  if (files.length) {
    lines.push(`**Files:** ${files.join(', ')}`);
  }

  if (blocked) {
    lines.push(`**Blocked:** ${blocked}`);
  }

  if (next) {
    lines.push(`**Next:** ${next}`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
