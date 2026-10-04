"use client";

import Image from "next/image";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export function MemoryNavigation({ active }: { active: "home" | "friends" | "albums" | null }) {
  const { data: session, isPending } = authClient.useSession();
  return (
    <nav className="memory-navigation" aria-label="Main navigation">
      <div className="memory-navigation-links">
        <Link aria-current={active === "home" ? "page" : undefined} href="/home">Home</Link>
        <Link aria-current={active === "friends" ? "page" : undefined} href="/friends">Friends</Link>
        <Link aria-current={active === "albums" ? "page" : undefined} href="/albums">Albums</Link>
        <Link href="/groups">Manage groups</Link>
      </div>
      {session ? (
        <Link className="nav-profile" href="/home" aria-label={`Signed in as ${session.user.name}`}>
          {session.user.image
            ? <Image src={session.user.image} alt="" width={36} height={36} unoptimized />
            : <span>{session.user.name.slice(0, 1).toUpperCase()}</span>}
        </Link>
      ) : (
        !isPending && <Link className="nav-sign-in" href="/sign-in">Sign in</Link>
      )}
    </nav>
  );
}
