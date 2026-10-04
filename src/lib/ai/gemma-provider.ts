import { Buffer } from "node:buffer";

export interface GemmaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface StructuredGenerationInput {
  task: string;
  contextPacket: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  images?: Uint8Array[];
}

export interface GemmaService {
  readonly modelVersion: string;
  generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
}

export interface GemmaInferenceMetrics {
  model: string;
  durationMs: number;
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptTokenCount?: number;
  outputTokenCount?: number;
}

export type GemmaMetricReporter = (metrics: GemmaInferenceMetrics) => void;

export class GemmaProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GemmaProviderError";
  }
}

function defaultConfig(defaultHost: string): GemmaConfig {
  let baseUrl = process.env.OLLAMA_HOST ?? defaultHost;
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `http://${baseUrl}`;
  }
  const configuredTimeout = Number(process.env.GEMMA_TIMEOUT_MS ?? 300_000);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    throw new GemmaProviderError("GEMMA_TIMEOUT_MS must be a positive number");
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: process.env.GEMMA_MODEL ?? "gemma4:e2b-it-q4_K_M",
    timeoutMs: configuredTimeout,
  };
}

function renderConfig(): GemmaConfig {
  const host = process.env.OLLAMA_HOST?.trim();
  if (!host) {
    throw new GemmaProviderError("OLLAMA_HOST must point to the Render private Gemma service");
  }
  return defaultConfig(host);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export class OllamaGemmaProvider implements GemmaService {
  constructor(
    private readonly config = defaultConfig("http://localhost:11434"),
    private readonly fetcher: typeof fetch = fetch,
    private readonly reportMetrics: GemmaMetricReporter = () => undefined,
  ) {}

  get modelVersion(): string {
    return this.config.model;
  }

  async generateStructured(
    input: StructuredGenerationInput,
  ): Promise<Record<string, unknown>> {
    if (!input.task.trim()) {
      throw new TypeError("task must not be empty");
    }

    const userMessage: Record<string, unknown> = {
      role: "user",
      content: JSON.stringify({
        task: input.task,
        context_packet: input.contextPacket,
      }),
    };
    if (input.images?.length) {
      userMessage.images = input.images.map((image) =>
        Buffer.from(image).toString("base64"),
      );
    }

    let response: Response;
    const startedAt = performance.now();
    try {
      response = await this.fetcher(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content:
                "Use only supplied evidence. Never invent people, events, places, or relationships. Preserve uncertainty and cite supplied fragment IDs. Return only data matching the JSON schema.",
            },
            userMessage,
          ],
          format: input.responseSchema,
          options: { temperature: 0 },
          stream: false,
        }),
      });
    } catch (error) {
      throw new GemmaProviderError("Could not reach the local Ollama service", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new GemmaProviderError(
        `Ollama returned HTTP ${response.status}`,
      );
    }

    let responseBody: {
      message?: { content?: unknown };
      total_duration?: unknown;
      load_duration?: unknown;
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };
    try {
      responseBody = (await response.json()) as {
        message?: { content?: unknown };
        total_duration?: unknown;
        load_duration?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
    } catch (error) {
      throw new GemmaProviderError("Ollama returned invalid JSON", {
        cause: error,
      });
    }

    if (typeof responseBody.message?.content !== "string") {
      throw new GemmaProviderError("Ollama response has no message content");
    }
    const metrics: GemmaInferenceMetrics = {
      model: this.config.model,
      durationMs: Math.round(performance.now() - startedAt),
      ...(typeof responseBody.total_duration === "number"
        ? { totalDurationNs: responseBody.total_duration }
        : {}),
      ...(typeof responseBody.load_duration === "number"
        ? { loadDurationNs: responseBody.load_duration }
        : {}),
      ...(typeof responseBody.prompt_eval_count === "number"
        ? { promptTokenCount: responseBody.prompt_eval_count }
        : {}),
      ...(typeof responseBody.eval_count === "number"
        ? { outputTokenCount: responseBody.eval_count }
        : {}),
    };
    this.reportMetrics(metrics);
    try {
      const result: unknown = JSON.parse(responseBody.message.content);
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new GemmaProviderError("Ollama response must be a JSON object");
      }
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GemmaProviderError) throw error;
      throw new GemmaProviderError("Ollama message content is not valid JSON", {
        cause: error,
      });
    }
  }
}

export class LocalGemmaAdapter extends OllamaGemmaProvider {
  constructor(
    config = defaultConfig("http://localhost:11434"),
    fetcher: typeof fetch = fetch,
    reportMetrics?: GemmaMetricReporter,
  ) {
    super(config, fetcher, reportMetrics);
  }
}

export class RenderGemmaAdapter extends OllamaGemmaProvider {
  constructor(
    config = renderConfig(),
    fetcher: typeof fetch = fetch,
    reportMetrics?: GemmaMetricReporter,
  ) {
    if (!config.baseUrl) {
      throw new GemmaProviderError("OLLAMA_HOST must point to the Render private Gemma service");
    }
    let hostname: string;
    try {
      hostname = new URL(config.baseUrl).hostname;
    } catch (error) {
      throw new GemmaProviderError("OLLAMA_HOST is not a valid service URL", { cause: error });
    }
    if (isLoopbackHost(hostname)) {
      throw new GemmaProviderError("Render Gemma configuration must not use a loopback host");
    }
    super(config, fetcher, reportMetrics);
  }
}

export function createGemmaService(): GemmaService {
  const runtime = process.env.GEMMA_RUNTIME ??
    (process.env.NODE_ENV === "production" ? "render" : "local");
  const reportMetrics: GemmaMetricReporter = (metrics) => {
    console.info("[gemma] inference metrics", metrics);
  };
  if (runtime === "local") {
    return new LocalGemmaAdapter(defaultConfig("http://localhost:11434"), fetch, reportMetrics);
  }
  if (runtime === "render") {
    return new RenderGemmaAdapter(renderConfig(), fetch, reportMetrics);
  }
  throw new GemmaProviderError("GEMMA_RUNTIME must be either local or render");
}