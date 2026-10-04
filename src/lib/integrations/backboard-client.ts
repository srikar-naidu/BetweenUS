export interface BackboardSettings {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface BackboardMemory {
  id: string;
  content: string;
  score: number | null;
}

export class BackboardConfigurationError extends Error {
  constructor() {
    super("Backboard is not configured");
    this.name = "BackboardConfigurationError";
  }
}

export class BackboardApiError extends Error {
  constructor(public readonly statusCode: number | null) {
    super("Backboard request failed");
    this.name = "BackboardApiError";
  }
}

export function getBackboardSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BackboardSettings | null {
  const apiKey = environment.BACKBOARD_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (environment.BACKBOARD_API_BASE_URL?.trim() || "https://app.backboard.io/api")
    .replace(/\/+$/, "");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new BackboardConfigurationError();
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new BackboardConfigurationError();
  }
  const timeoutMs = Number(environment.BACKBOARD_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new BackboardConfigurationError();
  }
  return { apiKey, baseUrl, timeoutMs };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

export class BackboardClient {
  constructor(
    private readonly settings: BackboardSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async createGroupAssistant(groupKey: string): Promise<string> {
    const response = await this.request("/assistants", {
      method: "POST",
      body: JSON.stringify({
        name: `Between Us group ${groupKey}`,
        system_prompt: "Store only member-approved group references. Do not infer facts or identify people.",
      }),
    });
    const body = record(await response.json());
    const assistantId = identifier(body?.assistant_id) ?? identifier(body?.id);
    if (!assistantId) throw new BackboardApiError(response.status);
    return assistantId;
  }

  async deleteAssistant(assistantId: string): Promise<void> {
    const response = await this.request(`/assistants/${encodeURIComponent(assistantId)}`, {
      method: "DELETE",
    }, [404]);
    if (!response.ok && response.status !== 404) throw new BackboardApiError(response.status);
    if (response.status === 202) {
      const body = record(await response.json());
      const operationId = identifier(body?.operation_id);
      if (!operationId) throw new BackboardApiError(response.status);
      await this.waitForOperation(operationId, async () => undefined);
    }
  }

  async addMemory(input: {
    assistantId: string;
    content: string;
    sourceKey: string;
    correctionType: string;
  }): Promise<{ memoryId: string; operationId: string | null }> {
    const response = await this.request(
      `/assistants/${encodeURIComponent(input.assistantId)}/memories`,
      {
        method: "POST",
        body: JSON.stringify({
          content: input.content,
          metadata: {
            source: "between-us-confirmed-correction",
            source_key: input.sourceKey,
            correction_type: input.correctionType,
          },
        }),
      },
    );
    const body = record(await response.json());
    const operationId = identifier(body?.operation_id);
    const memoryId = identifier(body?.memory_id) ?? identifier(body?.id);
    if (!memoryId && !operationId) throw new BackboardApiError(response.status);
    return { memoryId: memoryId ?? "", operationId };
  }

  async updateMemory(input: {
    assistantId: string;
    memoryId: string;
    content: string;
  }): Promise<string | null> {
    const response = await this.request(
      `/assistants/${encodeURIComponent(input.assistantId)}/memories/${encodeURIComponent(input.memoryId)}`,
      { method: "PUT", body: JSON.stringify({ content: input.content }) },
    );
    const body = response.status === 204 ? null : record(await response.json());
    return identifier(body?.operation_id);
  }

  async deleteMemory(input: {
    assistantId: string;
    memoryId: string;
  }): Promise<string | null> {
    const response = await this.request(
      `/assistants/${encodeURIComponent(input.assistantId)}/memories/${encodeURIComponent(input.memoryId)}`,
      { method: "DELETE" },
      [404],
    );
    if (response.status === 404) return null;
    const body = response.status === 204 ? null : record(await response.json());
    return identifier(body?.operation_id);
  }

  async searchMemories(input: {
    assistantId: string;
    query: string;
    limit: number;
  }): Promise<BackboardMemory[]> {
    const response = await this.request(
      `/assistants/${encodeURIComponent(input.assistantId)}/memories/search`,
      {
        method: "POST",
        body: JSON.stringify({ query: input.query.slice(0, 500), limit: input.limit }),
      },
    );
    const body = record(await response.json());
    if (!Array.isArray(body?.memories)) throw new BackboardApiError(response.status);
    return body.memories.flatMap((value) => {
      const memory = record(value);
      const id = identifier(memory?.id);
      const content = typeof memory?.content === "string" ? memory.content : null;
      if (!id || !content || !content.trim()) return [];
      return [{
        id,
        content: content.slice(0, 500),
        score: typeof memory?.score === "number" && Number.isFinite(memory.score)
          ? memory.score
          : null,
      }];
    });
  }

  async waitForOperation(
    operationId: string,
    onStatus: (status: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.settings.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request(
        `/assistants/memories/operations/${encodeURIComponent(operationId)}`,
        { method: "GET" },
      );
      const body = record(await response.json());
      const status = typeof body?.status === "string" ? body.status.toLowerCase() : "";
      if (!body || !status) throw new BackboardApiError(response.status);
      await onStatus(status);
      if (["completed", "complete", "succeeded", "success"].includes(status)) return body;
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        throw new BackboardApiError(null);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new BackboardApiError(null);
  }

  private async request(
    path: string,
    init: RequestInit,
    allowedStatuses: readonly number[] = [],
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher(`${this.settings.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "X-API-Key": this.settings.apiKey,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      if (!response.ok && response.status !== 202 && !allowedStatuses.includes(response.status)) {
        throw new BackboardApiError(response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof BackboardApiError) throw error;
      throw new BackboardApiError(null);
    } finally {
      clearTimeout(timer);
    }
  }
}
