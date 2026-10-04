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

export class GemmaProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GemmaProviderError";
  }
}

function defaultConfig(): GemmaConfig {
  let baseUrl = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    baseUrl = `http://${baseUrl}`;
  }
  const configuredTimeout = Number(process.env.GEMMA_TIMEOUT_MS ?? 300_000);
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: process.env.GEMMA_MODEL ?? "gemma4:e2b-it-q4_K_M",
    timeoutMs:
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 300_000,
  };
}

export class OllamaGemmaProvider {
  constructor(
    private readonly config = defaultConfig(),
    private readonly fetcher: typeof fetch = fetch,
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
      const detail = await response.text();
      throw new GemmaProviderError(
        `Ollama returned HTTP ${response.status}: ${detail}`,
      );
    }

    let responseBody: { message?: { content?: unknown } };
    try {
      responseBody = (await response.json()) as {
        message?: { content?: unknown };
      };
    } catch (error) {
      throw new GemmaProviderError("Ollama returned invalid JSON", {
        cause: error,
      });
    }

    if (typeof responseBody.message?.content !== "string") {
      throw new GemmaProviderError("Ollama response has no message content");
    }
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