import { evaluatePhase9 } from "./evaluate";

const report = evaluatePhase9();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.acceptance.passed) process.exitCode = 1;
