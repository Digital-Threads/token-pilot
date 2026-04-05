import { describe, it, expect } from 'vitest';
import { parseCsvOutline, parseCsvSectionSpec, extractCsvSectionContent, formatCsvOutline } from '../../src/handlers/csv-sections.js';

const SAMPLE_CSV = [
  'id,name,email,role',
  '1,John Doe,john@example.com,admin',
  '2,Jane Smith,jane@example.com,user',
  '3,Bob Wilson,bob@example.com,user',
  '4,Alice Brown,alice@example.com,admin',
  '5,Charlie Davis,charlie@example.com,user',
  '6,Eve Johnson,eve@example.com,user',
].join('\n');

describe('parseCsvOutline', () => {
  it('parses columns and row count', () => {
    const outline = parseCsvOutline(SAMPLE_CSV);
    expect(outline.columns).toEqual(['id', 'name', 'email', 'role']);
    expect(outline.rowCount).toBe(6);
  });

  it('returns first 5 sample rows', () => {
    const outline = parseCsvOutline(SAMPLE_CSV);
    expect(outline.sampleRows).toHaveLength(5);
    expect(outline.sampleRows[0]).toEqual(['1', 'John Doe', 'john@example.com', 'admin']);
  });

  it('handles empty content', () => {
    const outline = parseCsvOutline('');
    expect(outline.columns).toEqual([]);
    expect(outline.rowCount).toBe(0);
  });

  it('handles header-only CSV', () => {
    const outline = parseCsvOutline('name,email');
    expect(outline.columns).toEqual(['name', 'email']);
    expect(outline.rowCount).toBe(0);
    expect(outline.sampleRows).toEqual([]);
  });

  it('handles quoted fields with commas', () => {
    const csv = 'name,bio\n"Doe, John","He said ""hello"""';
    const outline = parseCsvOutline(csv);
    expect(outline.columns).toEqual(['name', 'bio']);
    expect(outline.sampleRows[0]).toEqual(['Doe, John', 'He said "hello"']);
  });
});

describe('parseCsvSectionSpec', () => {
  it('parses rows:1-3 range', () => {
    const section = parseCsvSectionSpec('rows:1-3', 6);
    expect(section).toBeDefined();
    expect(section!.heading).toBe('rows 1-3');
    expect(section!.startLine).toBe(2); // +1 for header
    expect(section!.endLine).toBe(4);
    expect(section!.lineCount).toBe(3);
  });

  it('parses single row: row:5', () => {
    const section = parseCsvSectionSpec('row:5', 6);
    expect(section).toBeDefined();
    expect(section!.heading).toBe('row 5');
    expect(section!.lineCount).toBe(1);
  });

  it('clamps to available rows', () => {
    const section = parseCsvSectionSpec('rows:1-100', 6);
    expect(section!.endLine).toBe(7); // 6 + 1 header offset
    expect(section!.lineCount).toBe(6);
  });

  it('returns null for out-of-range', () => {
    expect(parseCsvSectionSpec('rows:10-20', 6)).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(parseCsvSectionSpec('services', 6)).toBeNull();
  });
});

describe('extractCsvSectionContent', () => {
  it('includes header + requested rows', () => {
    const lines = SAMPLE_CSV.split('\n');
    const section = parseCsvSectionSpec('rows:1-2', 6)!;
    const content = extractCsvSectionContent(lines, section);
    expect(content).toContain('id,name,email,role');
    expect(content).toContain('John Doe');
    expect(content).toContain('Jane Smith');
    expect(content).not.toContain('Bob Wilson');
  });
});

describe('formatCsvOutline', () => {
  it('formats outline with columns, row count, and samples', () => {
    const outline = parseCsvOutline(SAMPLE_CSV);
    const output = formatCsvOutline('data.csv', outline, 7);
    expect(output).toContain('COLUMNS (4)');
    expect(output).toContain('ROWS: 6');
    expect(output).toContain('SAMPLE');
    expect(output).toContain('name=John Doe');
    expect(output).toContain('read_section');
  });
});
