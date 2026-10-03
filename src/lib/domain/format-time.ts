const captureTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatCaptureTime(value: Date | string): string {
  return `${captureTimeFormatter.format(new Date(value))}Z`;
}