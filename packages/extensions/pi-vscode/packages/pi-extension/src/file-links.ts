import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE_REVIEW_EXTENSION = "local.pi-vscode-review";

interface ParsedReference {
  rawPath: string;
  line?: number;
  column?: number;
}

const PATH_PATTERN = String.raw`(?:\/(?:[^\s:()[\]{}<>"'\x60#]+\/)*[^\s:()[\]{}<>"'\x60#]*|(?:\.{1,2}\/|(?:[A-Za-z0-9_.-]+\/)+)[^\s:()[\]{}<>"'\x60#]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)`;
const EXACT_REFERENCE = new RegExp(
  String.raw`^(${PATH_PATTERN})(?::(\d+)(?::(\d+))?|#L(\d+)(?::(\d+))?)?$`,
);
const PLAIN_REFERENCE = new RegExp(
  String.raw`(^|[\s(*])(${PATH_PATTERN})(?::(\d+)(?::(\d+))?|#L(\d+)(?::(\d+))?)(?=$|[\s).,;:'"\x60\]}*])`,
  "g",
);
const PROTECTED_MARKDOWN = /(`[^`\n]*`|\[[^\]\n]*\]\([^\)\n]*\))/g;

/** Converts file references in final assistant prose into Markdown OSC-8 links. */
export function linkifyFileReferences(text: string, cwd: string, enabled: boolean): string {
  if (!enabled) return text;

  let inFencedCodeBlock = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFencedCodeBlock = !inFencedCodeBlock;
        return line;
      }
      return inFencedCodeBlock ? line : linkifyLine(line, cwd);
    })
    .join("\n");
}

function linkifyLine(line: string, cwd: string): string {
  let result = "";
  let offset = 0;

  for (const token of line.matchAll(PROTECTED_MARKDOWN)) {
    const index = token.index ?? 0;
    result += linkifyPlainText(line.slice(offset, index), cwd);

    const value = token[0];
    if (value.startsWith("`") && value.endsWith("`")) {
      const reference = parseReference(value.slice(1, -1));
      result += reference ? markdownLink(value.slice(1, -1), reference, cwd) : value;
    } else {
      result += value;
    }
    offset = index + value.length;
  }

  return result + linkifyPlainText(line.slice(offset), cwd);
}

function linkifyPlainText(text: string, cwd: string): string {
  return text.replace(PLAIN_REFERENCE, (match, prefix: string, rawPath: string, line: string | undefined, column: string | undefined, hashLine: string | undefined, hashColumn: string | undefined) => {
    const reference = fromParts(rawPath, line ?? hashLine, column ?? hashColumn);
    return reference ? `${prefix}${markdownLink(match.slice(prefix.length), reference, cwd)}` : match;
  });
}

function parseReference(value: string): ParsedReference | undefined {
  const match = EXACT_REFERENCE.exec(value);
  if (!match?.[1]) return undefined;
  return fromParts(match[1], match[2] ?? match[4], match[3] ?? match[5]);
}

function fromParts(rawPath: string, line: string | undefined, column: string | undefined): ParsedReference {
  return {
    rawPath,
    line: parsePositiveNumber(line),
    column: parsePositiveNumber(column),
  };
}

function markdownLink(label: string, reference: ParsedReference, cwd: string): string {
  const filePath = path.isAbsolute(reference.rawPath) ? path.resolve(reference.rawPath) : path.resolve(cwd, reference.rawPath);
  if (!fs.existsSync(filePath)) return label;

  const query = new URLSearchParams({ path: filePath });
  if (reference.line) query.set("line", String(reference.line));
  if (reference.column) query.set("column", String(reference.column));

  return `[${label}](vscode://${VSCODE_REVIEW_EXTENSION}/open?${query.toString()})`;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
