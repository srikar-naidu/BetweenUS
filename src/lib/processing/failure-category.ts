const SAFE_FAILURE_CATEGORIES = new Set([
  "gemma_runtime_unavailable",
  "gemma_output_invalid",
  "fragment_source_unavailable",
  "fragment_ingestion_failed",
  "temporal_unavailable",
  "processing_worker_unavailable",
]);

export function safeProcessingFailureCategory(value: string | null | undefined): string {
  return value && SAFE_FAILURE_CATEGORIES.has(value)
    ? value
    : "fragment_ingestion_failed";
}
