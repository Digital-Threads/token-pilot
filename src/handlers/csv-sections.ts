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
  /** Lines of the header record. */
  headerStartLine?: number;
  headerEndLine?: number;
}

/** One CSV record and the file lines it occupies (1-based). */
export interface CsvRecordSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * Split CSV into records: a quoted field may span lines, blank lines are
 * not records. Line numbers point into the file as it is.
 */
export function csvRecords(content: string): CsvRecordSpan[] {
  const lines = content.split('\n');
  const out: CsvRecordSpan[] = [];
  let inQuote = false;
  let start = 0;
  let buf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!inQuote && line.trim() === '') continue;
    if (!inQuote) {
      start = i + 1;
      buf = [];
    }
    buf.push(line);
    for (const ch of line) if (ch === '"') inQuote = !inQuote; // "" toggles twice
    if (!inQuote) out.push({ start, end: i + 1, text: buf.join('\n') });
  }
  if (inQuote && buf.length > 0) out.push({ start, end: lines.length, text: buf.join('\n') });
  return out;
}

/**
 * Parse CSV into an outline: columns, row count, sample.
 * Handles quoted fields with commas and line breaks.
 */
export function parseCsvOutline(content: string): CsvOutline {
  const records = csvRecords(content);
  if (records.length === 0) return { columns: [], rowCount: 0, sampleRows: [] };

  const columns = parseCsvRow(records[0].text);
  const data = records.slice(1);

  return {
    columns,
    rowCount: data.length,
    sampleRows: data.slice(0, 5).map((r) => parseCsvRow(r.text)),
  };
}

/**
 * Parse a row range specification into a CsvSection.
 * Supported formats:
 *   "rows:1-50" — row range (1-indexed, refers to data rows, not header)
 *   "rows:1-50" with column filter isn't supported at section level
 */
export function parseCsvSectionSpec(heading: string, recordsOrRowCount: CsvRecordSpan[] | number): CsvSection | null {
  // a bare count means one line per record, header on line 1
  const records = typeof recordsOrRowCount === 'number'
    ? Array.from({ length: recordsOrRowCount + 1 }, (_, i) => ({ start: i + 1, end: i + 1, text: '' }))
    : recordsOrRowCount;
  const totalDataRows = records.length - 1;
  const span = (label: string, from: number, to: number): CsvSection => ({
    heading: label,
    startLine: records[from].start,
    endLine: records[to].end,
    lineCount: records[to].end - records[from].start + 1,
    headerStartLine: records[0].start,
    headerEndLine: records[0].end,
  });

  // rows:N-M format (data rows, 1-based, header excluded)
  const rowMatch = heading.match(/^rows?:\s*(\d+)\s*-\s*(\d+)$/i);
  if (rowMatch) {
    const start = Math.max(1, parseInt(rowMatch[1], 10));
    const end = Math.min(totalDataRows, parseInt(rowMatch[2], 10));
    if (start > end || start > totalDataRows) return null;
    return span(`rows ${start}-${end}`, start, end);
  }

  // Single row number
  const singleMatch = heading.match(/^rows?:\s*(\d+)$/i);
  if (singleMatch) {
    const row = parseInt(singleMatch[1], 10);
    if (row < 1 || row > totalDataRows) return null;
    return span(`row ${row}`, row, row);
  }

  return null;
}

/**
 * Extract CSV rows for a section. Returns header + requested rows.
 */
export function extractCsvSectionContent(lines: string[], section: CsvSection): string {
  const header = lines.slice((section.headerStartLine ?? 1) - 1, section.headerEndLine ?? 1); // always include header
  const dataRows = lines.slice(section.startLine - 1, section.endLine);
  return [...header, ...dataRows].join('\n');
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
