export interface SessionSnapshotArgs {
  goal: string;
  confirmed?: string[];
  files?: string[];
  blocked?: string;
  next?: string;
}

export function handleSessionSnapshot(args: SessionSnapshotArgs): { content: { type: 'text'; text: string }[] } {
  const lines: string[] = ['## Session State'];

  lines.push(`**Goal:** ${args.goal}`);

  if (args.confirmed?.length) {
    lines.push('**Confirmed:**');
    for (const item of args.confirmed) {
      lines.push(`- ${item}`);
    }
  }

  if (args.files?.length) {
    lines.push(`**Files:** ${args.files.join(', ')}`);
  }

  if (args.blocked) {
    lines.push(`**Blocked:** ${args.blocked}`);
  }

  if (args.next) {
    lines.push(`**Next:** ${args.next}`);
  }

  const text = lines.join('\n');
  return { content: [{ type: 'text', text }] };
}
