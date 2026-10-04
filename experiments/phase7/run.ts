import { evaluateSyntheticBenchmark } from "./benchmark";

const reports = (["development", "held_out", "all"] as const)
  .map((split) => evaluateSyntheticBenchmark(split));

process.stdout.write(`${JSON.stringify({
  reports,
  tinker: {
    status: "not_run",
    reason: "Tinker account, model compatibility, data terms, and spend approval are operator gates.",
  },
  limitations: [
    "This synthetic benchmark compares retrieval rankings, not Gemma or Tinker model outputs.",
    "Evidence-ID validity, uncertainty behavior, inference latency, and provider spend are not measured.",
    "Voice examples are synthetic transcript text; raw audio, image, and video examples are excluded.",
  ],
}, null, 2)}\n`);
