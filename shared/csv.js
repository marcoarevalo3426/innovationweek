// UTF-8/Excel-compatible CSV. Quoting also preserves commas and multiline ideas.
export function toCsv(headers, rows) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    // Quoting alone does not stop spreadsheet formulas in user-provided cells.
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
