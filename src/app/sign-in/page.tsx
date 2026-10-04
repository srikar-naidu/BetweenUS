import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { getAuthConfigurationStatus } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  const configuration = getAuthConfigurationStatus();

  return (
    <main className="shell trust-page" id="main-content">
      <a className="skip-link" href="#sign-in-content">Skip to sign in</a>
      <section className="trust-panel" id="sign-in-content" tabIndex={-1}>
        <p className="eyebrow">MEMBERS ONLY</p>
        <h1>Sign in to your group.</h1>
        <p className="lede">Your text fragments and reconstructed moments stay inside the groups you join.</p>
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