import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { getTemporalSettings } from "@/lib/processing/temporal-client";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

async function runWorker() {
  const settings = getTemporalSettings();
  if (!settings) throw new Error("TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE are required to run the worker");

  const connection = await NativeConnection.connect({
    address: settings.address,
    ...(settings.apiKey
      ? { tls: true, apiKey: settings.apiKey }
      : process.env.TEMPORAL_TLS === "true"
        ? { tls: true }
        : {}),
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities,
      shutdownGraceTime: "30 seconds",
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

runWorker().catch((error: unknown) => {
  const category = error instanceof Error ? error.name : "WorkerError";
  console.error(`Temporal worker stopped (${category})`);
  process.exitCode = 1;
});
