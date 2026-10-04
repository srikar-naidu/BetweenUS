"use client";

import { useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";

export function GoogleSignInButton({
  enabled,
  callbackURL = "/home",
}: {
  enabled: boolean;
  callbackURL?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function signIn() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await authClient.signIn.social({
          provider: "google",
          callbackURL: `${window.location.origin}${callbackURL}`,
        });
        if (result.error) setError("Google sign-in could not be started. Try again.");
      } catch {
        setError("Google sign-in could not be started. Try again.");
      }
    });
  }

  return (
    <div className="auth-action">
      <button className="primary-button" disabled={!enabled || isPending} onClick={signIn}>
        {isPending ? "Connecting…" : "Continue with Google"}
      </button>
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
  );
}