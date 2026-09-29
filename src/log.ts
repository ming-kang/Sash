const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function terminalText(value: string): string {
  return value.replace(/\p{Cc}/gu, (char) =>
    char === "\n" ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of segments.segment(value)) {
    if (/^[\p{Mark}\p{Format}]+$/u.test(segment)) continue;
    width +=
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff01-\uff60]/u.test(
        segment,
      )
        ? 2
        : 1;
  }
  return width;
}

export const log = {
  info(msg: string): void {
    console.log(terminalText(msg));
  },
  ok(msg: string): void {
    console.log(terminalText(msg));
  },
  warn(msg: string): void {
    console.warn(`Warning: ${terminalText(msg)}`);
  },
  error(msg: string): void {
    console.error(`Error: ${terminalText(msg)}`);
  },
  kv(key: string, value: string): void {
    log.table([[key, value]], 12);
  },
  table(rows: readonly (readonly string[])[], minimumFirstWidth = 0): void {
    const safe = rows.map((row) => row.map((cell) => terminalText(cell).replaceAll("\n", "\\n")));
    const widths = Array.from(
      { length: Math.max(0, ...safe.map((row) => row.length - 1)) },
      (_, column) =>
        Math.max(
          column === 0 ? minimumFirstWidth : 0,
          ...safe.map((row) => displayWidth(row[column] ?? "")),
        ),
    );
    for (const row of safe) {
      const prefix = row
        .slice(0, -1)
        .map((cell, index) => cell + " ".repeat((widths[index] ?? 0) - displayWidth(cell) + 2))
        .join("");
      const indent = displayWidth(prefix);
      const available = process.stdout.isTTY
        ? Math.max(20, (process.stdout.columns || 100) - indent)
        : Infinity;
      let line = prefix;
      let used = 0;
      for (const { segment } of segments.segment(row.at(-1) ?? "")) {
        const width = displayWidth(segment);
        if (used + width > available) {
          console.log(line);
          line = " ".repeat(indent);
          used = 0;
        }
        line += segment;
        used += width;
      }
      console.log(line);
    }
  },
};
