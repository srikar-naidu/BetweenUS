"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function MemoryNavigation() {
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function signOut() {
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out request failed");
      router.replace("/");
      router.refresh();
    } catch {
      setSignOutError("Could not sign out. Please try again.");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <nav className="memory-navigation" aria-label="Main navigation">
      <div className="memory-navigation-links">
        <Link aria-current={pathname === "/home" ? "page" : undefined} href="/home">Home</Link>
        <Link aria-current={pathname === "/friends" ? "page" : undefined} href="/friends">Friends</Link>
        <Link aria-current={pathname === "/albums" ? "page" : undefined} href="/albums">Albums</Link>
        <Link aria-current={pathname === "/groups" || pathname.startsWith("/groups/") ? "page" : undefined} href="/groups">Manage groups</Link>
      </div>
      {session ? (
        <div className="memory-navigation-account">
          <button className="nav-sign-out" type="button" onClick={() => void signOut()} disabled={isSigningOut}>
            {isSigningOut ? "Signing out…" : "Sign out"}
          </button>
          <Link className="nav-profile" href="/home" aria-label={`Signed in as ${session.user.name}`}>
            {session.user.image
              ? <Image src={session.user.image} alt="" width={36} height={36} unoptimized />
              : <span>{session.user.name.slice(0, 1).toUpperCase()}</span>}
          </Link>
        </div>
      ) : (
        (!isPending || pathname === "/sign-in") && <Link className="nav-sign-in" href="/sign-in">Sign in</Link>
      )}
      {signOutError && <span className="nav-auth-error" role="alert">{signOutError}</span>}
    </nav>
  );
}
