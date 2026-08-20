import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface FormattedOutput {
  text: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
}

export async function formatToolOutput(
  output: string,
  prefix: string,
  limits: { maxLines?: number; maxBytes?: number } = {},
): Promise<FormattedOutput> {
  const truncation = truncateTail(output, {
    maxLines: limits.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: limits.maxBytes ?? DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return { text: truncation.content, truncation };

  const directory = await mkdtemp(join(tmpdir(), `pi-${prefix}-`));
  const fullOutputPath = join(directory, "output.txt");
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, output, "utf8"));

  const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines `
    + `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). `
    + `Full output saved to: ${fullOutputPath}]`;

  return {
    text: `${truncation.content}\n\n${notice}`,
    truncation,
    fullOutputPath,
  };
}
