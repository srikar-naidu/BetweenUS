"use client";

import { useEffect, useState } from "react";

async function closeAudioContext(context: AudioContext | null): Promise<void> {
  if (context && context.state !== "closed") await context.close();
}

function getWaveformPeaks(channel: Float32Array, bars = 64): number[] {
  return Array.from({ length: bars }, (_, index) => {
    const start = Math.floor(index * channel.length / bars);
    const end = Math.max(start + 1, Math.floor((index + 1) * channel.length / bars));
    let peak = 0;
    for (let sample = start; sample < Math.min(end, channel.length); sample += 1) {
      peak = Math.max(peak, Math.abs(channel[sample]));
    }
    return Math.max(0.08, peak);
  });
}

export function AudioWaveform({ src, label }: { src: string; label: string }) {
  const [peaks, setPeaks] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let audioContext: AudioContext | null = null;

    async function loadWaveform() {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error("Audio preview is unavailable");
        const bytes = await response.arrayBuffer();
        audioContext = new AudioContext();
        const decoded = await audioContext.decodeAudioData(bytes);
        if (!cancelled) setPeaks(getWaveformPeaks(decoded.getChannelData(0)));
      } catch {
        if (!cancelled) setPeaks([]);
      } finally {
        await closeAudioContext(audioContext);
      }
    }

    void loadWaveform();
    return () => {
      cancelled = true;
      void closeAudioContext(audioContext);
    };
  }, [src]);

  return (
    <div className="audio-waveform" aria-label={`${label} waveform and player`}>
      {peaks.length > 0 && (
        <div className="audio-waveform-bars" aria-hidden="true">
          {peaks.map((peak, index) => (
            <span key={index} style={{ height: `${Math.max(8, Math.round(peak * 100))}%` }} />
          ))}
        </div>
      )}
      <audio controls preload="metadata" src={src} aria-label={label}>
        Your browser does not support audio playback.
      </audio>
    </div>
  );
}
