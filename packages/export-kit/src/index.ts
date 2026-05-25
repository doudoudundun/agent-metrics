function escapeCsvValue(value: string | number | null | undefined): string {
  const text = String(value ?? "");

  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const body = rows
    .map((row) => headers.map((header) => escapeCsvValue(row[header])).join(","))
    .join("\n");

  return [headers.join(","), body].join("\n");
}

export function toJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}
