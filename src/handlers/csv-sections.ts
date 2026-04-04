/**
 * CSV parser — column-aware reading with row/column subsetting.
 */

export interface CsvOutline {
  columns: string[];
  rowCount: number;
  sampleRows: string[][]; // first 5 data rows
}

export interface CsvSection {
  heading: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/**
 * Parse CSV into an outline: columns, row count, sample.
 * Simple parser — handles quoted fields with commas.
 */
export function parseCsvOutline(content: string): CsvOutline {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { columns: [], rowCount: 0, sampleRows: [] };

  const columns = parseCsvRow(lines[0]);
  const dataLines = lines.slice(1);
  const sampleRows = dataLines.slice(0, 5).map(parseCsvRow);

  return {
    columns,
    rowCount: dataLines.length,
    sampleRows,
  };
}

/**
 * Parse a row range specification into a CsvSection.
 * Supported formats:
 *   "rows:1-50" — row range (1-indexed, refers to data rows, not header)
 *   "rows:1-50" with column filter isn't supported at section level
 */
export function parseCsvSectionSpec(heading: string, totalDataRows: number): CsvSection | null {
  // rows:N-M format
  const rowMatch = heading.match(/^rows?:\s*(\d+)\s*-\s*(\d+)$/i);
  if (rowMatch) {
    const start = Math.max(1, parseInt(rowMatch[1], 10));
    const end = Math.min(totalDataRows, parseInt(rowMatch[2], 10));
    if (start > end || start > totalDataRows) return null;
    // +1 for header line offset
    return {
      heading: `rows ${start}-${end}`,
      startLine: start + 1, // +1 because line 1 is header
      endLine: end + 1,
      lineCount: end - start + 1,
    };
  }

  // Single row number
  const singleMatch = heading.match(/^rows?:\s*(\d+)$/i);
  if (singleMatch) {
    const row = parseInt(singleMatch[1], 10);
    if (row < 1 || row > totalDataRows) return null;
    return {
      heading: `row ${row}`,
      startLine: row + 1,
      endLine: row + 1,
      lineCount: 1,
    };
  }

  return null;
}

/**
 * Extract CSV rows for a section. Returns header + requested rows.
 */
export function extractCsvSectionContent(lines: string[], section: CsvSection): string {
  const header = lines[0]; // always include header
  const dataRows = lines.slice(section.startLine - 1, section.endLine);
  return [header, ...dataRows].join('\n');
}

/**
 * Parse a single CSV row handling quoted fields.
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Format CSV outline for smart_read output.
 */
export function formatCsvOutline(filePath: string, outline: CsvOutline, lineCount: number): string {
  const lines: string[] = [
    `FILE: ${filePath} (${lineCount} lines, CSV)`,
    '',
    `COLUMNS (${outline.columns.length}): ${outline.columns.join(', ')}`,
    `ROWS: ${outline.rowCount}`,
    '',
  ];

  if (outline.sampleRows.length > 0) {
    lines.push(`SAMPLE (first ${outline.sampleRows.length} rows):`);
    for (const row of outline.sampleRows) {
      // Format as: col1=val1, col2=val2, ...
      const pairs = outline.columns.map((col, i) => `${col}=${row[i] ?? ''}`);
      lines.push(`  ${pairs.join(', ')}`);
    }
  }

  lines.push('');
  lines.push(`HINT: Use read_section("${filePath}", heading="rows:1-50") to load specific rows.`);
  lines.push(`      Use read_section("${filePath}", heading="rows:${outline.rowCount}") for last row.`);

  return lines.join('\n');
}
