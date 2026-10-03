import Link from "next/link";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { getAuthConfigurationStatus } from "@/lib/auth";

export default function SignInPage() {
  const configuration = getAuthConfigurationStatus();

  return (
    <main className="shell trust-page">
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <span className="group-label">PRIVATE GROUP MEMORY</span>
      </header>
      <section className="trust-panel">
        <p className="eyebrow">MEMBERS ONLY</p>
        <h1>Sign in to your group.</h1>
        <p className="lede">Your uploads and reconstructed moments stay inside the groups you join.</p>
        {!configuration.configured && (
          <p className="setup-message" role="status">
            Sign-in is unavailable until the server is configured with: {configuration.missing.join(", ")}.
          </p>
        )}
        <GoogleSignInButton enabled={configuration.configured} />
      </section>
    </main>
  );
}