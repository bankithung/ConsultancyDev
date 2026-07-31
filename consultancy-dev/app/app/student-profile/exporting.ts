/** CSV and print helpers shared by the payment and refund panels. */

/** Quotes a CSV cell and doubles any embedded quote, per RFC 4180. */
function toCsvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Builds a CSV and hands it to the browser as a download.
 *
 * Prefixed with a BOM so Excel opens `₹` and non-ASCII names correctly instead
 * of showing mojibake.
 */
export function downloadCsv(fileName: string, headers: string[], rows: Array<Array<string | number>>): void {
  const csv = [headers, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const PRINT_STYLES = `
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; color: #0f172a; }
  h1 { font-size: 20px; color: #0f766e; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  .summary { background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 6px; padding: 12px; margin-bottom: 16px; font-size: 13px; }
  .summary p { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
  th { background: #0f766e; color: #fff; }
`;

export interface PrintTableOptions {
  title: string;
  /** Small grey line under the heading, e.g. the generation date. */
  subtitle?: string;
  /** `label: value` rows rendered in the tinted summary box. */
  summary?: Array<{ label: string; value: string }>;
  headers: string[];
  rows: Array<Array<string | number>>;
}

/**
 * Opens a print-ready window containing a titled table.
 *
 * Everything is built with `createElement`/`textContent` rather than
 * `document.write` or `innerHTML`, so a student name containing `<` is text and
 * can never become markup. Returns false when the pop-up was blocked, so the
 * caller can say so instead of leaving the user staring at nothing.
 */
export function printTable({ title, subtitle, summary, headers, rows }: PrintTableOptions): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;

  const doc = printWindow.document;
  doc.title = title;

  const style = doc.createElement('style');
  style.textContent = PRINT_STYLES;
  doc.head.appendChild(style);

  const heading = doc.createElement('h1');
  heading.textContent = title;
  doc.body.appendChild(heading);

  if (subtitle) {
    const meta = doc.createElement('p');
    meta.className = 'meta';
    meta.textContent = subtitle;
    doc.body.appendChild(meta);
  }

  if (summary && summary.length > 0) {
    const box = doc.createElement('div');
    box.className = 'summary';
    for (const entry of summary) {
      const line = doc.createElement('p');
      const label = doc.createElement('strong');
      label.textContent = `${entry.label}: `;
      line.appendChild(label);
      line.appendChild(doc.createTextNode(entry.value));
      box.appendChild(line);
    }
    doc.body.appendChild(box);
  }

  const table = doc.createElement('table');

  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const header of headers) {
    const th = doc.createElement('th');
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  for (const row of rows) {
    const tr = doc.createElement('tr');
    for (const cell of row) {
      const td = doc.createElement('td');
      td.textContent = String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  doc.body.appendChild(table);

  printWindow.focus();
  printWindow.print();
  return true;
}
