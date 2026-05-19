import { extname } from "node:path";

export type ChunkKind = "function" | "class" | "method" | "block" | "text";

export interface SmartChunk {
  startLine: number;
  endLine: number;
  text: string;
  symbol?: string;
  kind: ChunkKind;
}

/**
 * Boundary-aware chunker. For supported languages we recognize the most
 * common top-level constructs (function / class / interface) via regex,
 * split _before_ each, and emit one chunk per construct (or one chunk per
 * 80-line block in unrecognized regions). For unsupported file types we
 * fall back to overlapping line windows.
 *
 * This is not a full AST parser, but it keeps function bodies intact —
 * which is the failure mode line-chunking has.
 */
export function smartChunks(args: {
  path: string;
  content: string;
  maxLines?: number;
  overlap?: number;
}): SmartChunk[] {
  const maxLines = args.maxLines ?? 80;
  const overlap = args.overlap ?? 10;
  const ext = extname(args.path).toLowerCase();
  const lang = languageFor(ext);
  if (!lang) return lineChunks(args.content, maxLines, overlap);

  const lines = args.content.split("\n");
  const boundaries = findBoundaries(lang, lines);
  if (boundaries.length === 0) return lineChunks(args.content, maxLines, overlap);

  const chunks: SmartChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    const next = boundaries[i + 1];
    const start = b.line;
    const end = next ? next.line : lines.length;
    const span = end - start;
    if (span <= maxLines) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        text: lines.slice(start, end).join("\n"),
        symbol: b.symbol,
        kind: b.kind,
      });
    } else {
      // Long region — split into sub-windows but tag with the symbol.
      for (let off = 0; off < span; off += maxLines - overlap) {
        const subStart = start + off;
        const subEnd = Math.min(start + off + maxLines, end);
        chunks.push({
          startLine: subStart + 1,
          endLine: subEnd,
          text: lines.slice(subStart, subEnd).join("\n"),
          symbol: b.symbol,
          kind: b.kind,
        });
        if (subEnd === end) break;
      }
    }
  }

  // Capture anything before the first boundary as a header chunk
  if (boundaries[0]!.line > 0) {
    const headerLines = lines.slice(0, boundaries[0]!.line);
    if (headerLines.some((l) => l.trim() !== "")) {
      chunks.unshift({
        startLine: 1,
        endLine: boundaries[0]!.line,
        text: headerLines.join("\n"),
        kind: "block",
      });
    }
  }
  return chunks;
}

type Lang = "ts" | "py" | "go" | "rs" | "java" | "rb";

function languageFor(ext: string): Lang | null {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "ts";
    case ".py":
      return "py";
    case ".go":
      return "go";
    case ".rs":
      return "rs";
    case ".java":
    case ".kt":
      return "java";
    case ".rb":
      return "rb";
    default:
      return null;
  }
}

interface Boundary {
  line: number;
  symbol: string;
  kind: ChunkKind;
}

function findBoundaries(lang: Lang, lines: string[]): Boundary[] {
  const out: Boundary[] = [];
  const regex = REGEXES[lang];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const r of regex) {
      const m = r.pattern.exec(line);
      if (m) {
        out.push({ line: i, symbol: m[1] ?? "(anon)", kind: r.kind });
        break;
      }
    }
  }
  return out;
}

const REGEXES: Record<Lang, { pattern: RegExp; kind: ChunkKind }[]> = {
  ts: [
    { pattern: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { pattern: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { pattern: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*interface\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function" },
  ],
  py: [
    { pattern: /^\s*def\s+([A-Za-z_][\w]*)/, kind: "function" },
    { pattern: /^\s*async\s+def\s+([A-Za-z_][\w]*)/, kind: "function" },
    { pattern: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "class" },
  ],
  go: [
    { pattern: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/, kind: "function" },
    { pattern: /^\s*type\s+([A-Za-z_][\w]*)\s+struct/, kind: "class" },
    { pattern: /^\s*type\s+([A-Za-z_][\w]*)\s+interface/, kind: "class" },
  ],
  rs: [
    { pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: "function" },
    { pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "class" },
    { pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/, kind: "class" },
    { pattern: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w<>,\s]*\s+for\s+)?([A-Za-z_][\w]*)/, kind: "class" },
  ],
  java: [
    { pattern: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)*(?:class|interface|enum)\s+([A-Za-z_][\w]*)/, kind: "class" },
    { pattern: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+)+[A-Za-z_][\w<>?\[\]]*\s+([A-Za-z_][\w]*)\s*\(/, kind: "method" },
    { pattern: /^\s*fun\s+([A-Za-z_][\w]*)/, kind: "function" },
  ],
  rb: [
    { pattern: /^\s*def\s+(?:self\.)?([A-Za-z_][\w?!]*)/, kind: "function" },
    { pattern: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "class" },
    { pattern: /^\s*module\s+([A-Za-z_][\w]*)/, kind: "class" },
  ],
};

function lineChunks(content: string, maxLines: number, overlap: number): SmartChunk[] {
  const lines = content.split("\n");
  if (lines.length <= maxLines) {
    return [{
      startLine: 1,
      endLine: lines.length,
      text: content,
      kind: "text",
    }];
  }
  const out: SmartChunk[] = [];
  const step = maxLines - overlap;
  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + maxLines, lines.length);
    out.push({
      startLine: i + 1,
      endLine: end,
      text: lines.slice(i, end).join("\n"),
      kind: "text",
    });
    if (end === lines.length) break;
  }
  return out;
}
