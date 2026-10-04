const INVITATION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export function extractInvitationId(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  if (INVITATION_ID_PATTERN.test(input)) return input;

  try {
    const url = input.startsWith("/")
      ? new URL(input, "http://between-us.local")
      : new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (url.origin === "http://between-us.local" && !input.startsWith("/invite/"))
    ) {
      return null;
    }

    const match = /^\/invite\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    const invitationId = decodeURIComponent(match[1]);
    return INVITATION_ID_PATTERN.test(invitationId) ? invitationId : null;
  } catch {
    return null;
  }
}
