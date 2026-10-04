"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  ...(typeof window !== "undefined" ? { baseURL: window.location.origin } : {}),
  plugins: [organizationClient()],
});