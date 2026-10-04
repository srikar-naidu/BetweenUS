import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { MAX_VIDEO_ANALYSIS_FRAMES } from "@/lib/ai/fragment-analysis";

const MAX_FRAME_OUTPUT_BYTES = 12_000_000;
const FRAME_INTERVAL_SECONDS = 10;
const MAX_DECODE_MILLISECONDS = 30_000;

export interface SampledVideoFrame {
  locator: string;
  bytes: Buffer;
}

export function splitJpegFrames(buffer: Buffer, maximumFrames: number): Buffer[] {
  const frames: Buffer[] = [];
  let cursor = 0;
  while (frames.length < maximumFrames) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0) break;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    frames.push(Buffer.from(buffer.subarray(start, end + 2)));
    cursor = end + 2;
  }
  return frames;
}

export async function sampleVideoFrames(videoBytes: Uint8Array): Promise<SampledVideoFrame[]> {
  if (!ffmpegPath) {
    throw new Error("The bundled FFmpeg executable is unavailable");
  }

  const child = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-threads",
    "1",
    "-i",
    "pipe:0",
    "-t",
    String(FRAME_INTERVAL_SECONDS * MAX_VIDEO_ANALYSIS_FRAMES),
    "-vf",
    `fps=1/${FRAME_INTERVAL_SECONDS},scale=1280:-2:force_original_aspect_ratio=decrease`,
    "-frames:v",
    String(MAX_VIDEO_ANALYSIS_FRAMES),
    "-q:v",
    "5",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "ignore"] });

  const output: Buffer[] = [];
  let outputBytes = 0;
  let processError: Error | null = null;
  let exceededOutputLimit = false;
  let exceededTimeLimit = false;
  const timer = setTimeout(() => {
    exceededTimeLimit = true;
    child.kill("SIGKILL");
  }, MAX_DECODE_MILLISECONDS);

  child.stdout.on("data", (chunk: Buffer | Uint8Array) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_FRAME_OUTPUT_BYTES) {
      exceededOutputLimit = true;
      child.kill("SIGKILL");
      return;
    }
    output.push(Buffer.from(chunk));
  });
  child.once("error", (error) => {
    processError = error;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
    child.stdin.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
    });
    child.stdin.end(Buffer.from(videoBytes));
  }).finally(() => clearTimeout(timer));

  if (processError) {
    throw new Error("FFmpeg could not start", { cause: processError });
  }
  if (exceededTimeLimit) {
    throw new Error("Video frame sampling exceeded its time limit");
  }
  if (exceededOutputLimit) {
    throw new Error("Video frame sampling exceeded its memory limit");
  }
  if (exitCode !== 0) {
    throw new Error("Video could not be decoded for private analysis");
  }

  const frames = splitJpegFrames(Buffer.concat(output, outputBytes), MAX_VIDEO_ANALYSIS_FRAMES);
  if (!frames.length) {
    throw new Error("Video did not contain a decodable frame");
  }
  return frames.map((bytes, index) => ({
    locator: `frame_${index}_at_${index * FRAME_INTERVAL_SECONDS}s`,
    bytes,
  }));
}
