import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.6-luna";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

interface Source {
  title?: string;
  url: string;
}

interface SearchResponse {
  text: string;
  sources: Source[];
  queries: string[];
  usage?: Usage;
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      `Search the live web using OpenAI hosted web search. Returns search findings and source URLs. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for current or externally sourced information.`,
    promptSnippet: "Search the live web for current information and sources",
    promptGuidelines: [
      "Use web_search when the request needs current information or facts that should be verified against web sources.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "A focused web search query" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Searching the web for: ${params.query}` }],
        details: { query: params.query },
      });

      const result = await searchWeb(params.query, ctx, signal);
      const formatted = formatResult(params.query, result);
      const output = await truncateWebSearchOutput(formatted);

      return {
        content: [{ type: "text", text: output.text }],
        details: {
          query: params.query,
          queries: result.queries,
          sources: result.sources,
          ...output.details,
        },
        usage: result.usage,
      };
    },
  });
}

async function searchWeb(
  query: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const model = selectSearchModel(ctx);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) {
    throw new Error("OpenAI Codex OAuth is not configured. Run /login openai-codex first.");
  }

  const accountId = extractAccountId(auth.apiKey);
  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi-web-search");
  headers.set("User-Agent", "pi-web-search/0.1.0");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");

  const response = await fetch(resolveCodexUrl(model.baseUrl), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model: model.id,
      store: false,
      stream: true,
      instructions:
        "Search the live web for the user's query. Return useful factual findings grounded in the search results. Do not rely on memory.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: query }],
        },
      ],
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "medium",
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI web search failed (${response.status}): ${readErrorMessage(body)}`);
  }
  if (!response.body) throw new Error("OpenAI web search returned no response body.");

  return parseResponseStream(response.body, model, signal);
}

function selectSearchModel(ctx: ExtensionContext): Model<"openai-codex-responses"> {
  const requested = process.env.PI_WEB_SEARCH_MODEL?.trim();
  const activeId = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
  const candidates = [requested, activeId, DEFAULT_MODEL, "gpt-5.6-sol"];

  for (const id of candidates) {
    if (!id) continue;
    const model = ctx.modelRegistry.find(PROVIDER, id);
    if (model?.api === "openai-codex-responses") {
      return model as Model<"openai-codex-responses">;
    }
  }

  throw new Error(
    `No OpenAI Codex search model is available. Set PI_WEB_SEARCH_MODEL to an available ${PROVIDER} model.`,
  );
}

function resolveCodexUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      [ACCOUNT_ID_CLAIM]?: { chatgpt_account_id?: string };
    };
    const accountId = payload[ACCOUNT_ID_CLAIM]?.chatgpt_account_id;
    if (!accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error("Could not read the ChatGPT account ID from the OpenAI OAuth token.");
  }
}

async function parseResponseStream(
  body: ReadableStream<Uint8Array>,
  model: Model<"openai-codex-responses">,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const texts = new Map<string, string>();
  const sources = new Map<string, Source>();
  const queries = new Set<string>();
  let streamedText = "";
  let usage: Usage | undefined;
  let terminalEventSeen = false;

  await readSse(body, signal, (event) => {
    const type = stringValue(event.type);

    if (type === "response.output_text.delta") {
      streamedText += stringValue(event.delta) ?? "";
    }

    if (type === "response.output_item.done" || type === "response.output_item.added") {
      inspectOutputItem(event.item, texts, sources, queries);
    }

    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      terminalEventSeen = true;
      const response = objectValue(event.response);
      for (const item of arrayValue(response?.output)) {
        inspectOutputItem(item, texts, sources, queries);
      }
      usage = parseUsage(response?.usage, model) ?? usage;
    }

    if (type === "response.failed") {
      terminalEventSeen = true;
      const response = objectValue(event.response);
      const error = objectValue(response?.error);
      throw new Error(stringValue(error?.message) ?? "OpenAI web search response failed.");
    }

    if (type === "error") {
      throw new Error(stringValue(event.message) ?? "OpenAI web search stream failed.");
    }
  });

  if (!terminalEventSeen) {
    throw new Error("OpenAI web search stream ended before completion.");
  }

  const finalText = [...texts.values()].filter(Boolean).join("\n\n").trim() || streamedText.trim();
  if (!finalText && sources.size === 0) {
    throw new Error("OpenAI web search returned no findings.");
  }

  return {
    text: finalText,
    sources: [...sources.values()],
    queries: [...queries],
    usage,
  };
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Web search was aborted.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSseFrames(buffer, onEvent);
    }

    buffer += decoder.decode();
    consumeSseFrames(`${buffer}\n\n`, onEvent);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
    reader.releaseLock();
  }
}

function consumeSseFrames(
  input: string,
  onEvent: (event: Record<string, unknown>) => void,
): string {
  let buffer = input;

  while (true) {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match || match.index === undefined) return buffer;

    const frame = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data) as unknown;
      const event = objectValue(parsed);
      if (event) onEvent(event);
    } catch {
      throw new Error("OpenAI web search returned invalid stream data.");
    }
  }
}

function inspectOutputItem(
  value: unknown,
  texts: Map<string, string>,
  sources: Map<string, Source>,
  queries: Set<string>,
): void {
  const item = objectValue(value);
  if (!item) return;

  if (item.type === "message") {
    const id = stringValue(item.id) ?? `message-${texts.size}`;
    const parts: string[] = [];
    for (const rawContent of arrayValue(item.content)) {
      const content = objectValue(rawContent);
      if (!content || content.type !== "output_text") continue;
      const text = stringValue(content.text);
      if (text) parts.push(text);
      for (const annotation of arrayValue(content.annotations)) {
        addSource(annotation, sources);
      }
    }
    if (parts.length > 0) texts.set(id, parts.join(""));
  }

  if (item.type === "web_search_call") {
    const action = objectValue(item.action);
    const query = stringValue(action?.query);
    if (query) queries.add(query);
    for (const value of arrayValue(action?.queries)) {
      if (typeof value === "string") queries.add(value);
    }
    for (const source of arrayValue(action?.sources)) {
      addSource(source, sources);
    }
  }
}

function addSource(value: unknown, sources: Map<string, Source>): void {
  const source = objectValue(value);
  const url = stringValue(source?.url) ?? stringValue(source?.source_website_url);
  if (!url || sources.has(url)) return;
  sources.set(url, { url, title: stringValue(source?.title) ?? stringValue(source?.caption) });
}

function parseUsage(
  value: unknown,
  model: Model<"openai-codex-responses">,
): Usage | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;

  const inputDetails = objectValue(raw.input_tokens_details);
  const outputDetails = objectValue(raw.output_tokens_details);
  const cached = numberValue(inputDetails?.cached_tokens);
  const cacheWrite = numberValue(inputDetails?.cache_write_tokens);
  const totalInput = numberValue(raw.input_tokens);
  const output = numberValue(raw.output_tokens);

  const usage: Usage = {
    input: Math.max(0, totalInput - cached - cacheWrite),
    output,
    cacheRead: cached,
    cacheWrite,
    reasoning: numberValue(outputDetails?.reasoning_tokens),
    totalTokens: numberValue(raw.total_tokens) || totalInput + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function formatResult(query: string, result: SearchResponse): string {
  const sections = [`Web search response for: ${query}`];
  if (result.text) sections.push(result.text);

  if (result.sources.length > 0) {
    sections.push(
      [
        "Sources:",
        ...result.sources.map((source) =>
          source.title ? `- ${source.title}: ${source.url}` : `- ${source.url}`,
        ),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

export async function truncateWebSearchOutput(fullOutput: string): Promise<{
  text: string;
  details?: { truncation: TruncationResult; fullOutputPath: string };
}> {
  const truncation = truncateTail(fullOutput, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: fullOutput };

  const fullOutputPath = join(
    tmpdir(),
    `pi-web-search-${randomBytes(8).toString("hex")}.log`,
  );
  await writeFile(fullOutputPath, fullOutput, "utf8");

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  let text = truncation.content;

  if (truncation.lastLinePartial) {
    const finalLine = fullOutput.slice(fullOutput.lastIndexOf("\n") + 1);
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(Buffer.byteLength(finalLine, "utf8"))}). Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }

  return {
    text,
    details: { truncation, fullOutputPath },
  };
}

function readErrorMessage(body: string): string {
  try {
    const parsed = objectValue(JSON.parse(body));
    const error = objectValue(parsed?.error);
    return stringValue(error?.message) ?? body;
  } catch {
    return body || "Unknown error";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
