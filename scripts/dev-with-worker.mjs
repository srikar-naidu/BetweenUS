import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const dnsBootstrap = path.join(root, "scripts", "node-dns-bootstrap.cjs");
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const worker = path.join(root, "src", "processing-worker.ts");
const nextArgs = process.argv.slice(2);
const children = [
  spawn(process.execPath, ["--require", dnsBootstrap, nextCli, "dev", ...nextArgs], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
  spawn(process.execPath, ["--require", dnsBootstrap, "--import", "tsx", worker], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const forceStop = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
  forceStop.unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Could not start the local app or MongoDB worker.", error.message);
    process.exitCode = 1;
    stop("SIGTERM");
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      process.exitCode = code ?? (signal ? 1 : 0);
      stop("SIGTERM");
    }
    if (stopping && children.every((running) =>
      running.exitCode !== null || running.signalCode !== null
    )) {
      process.exit(process.exitCode ?? 0);
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
