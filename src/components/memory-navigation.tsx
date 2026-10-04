import Link from "next/link";

export function MemoryNavigation({ active }: { active: "home" | "friends" | "albums" }) {
  return (
    <nav className="memory-navigation" aria-label="Main navigation">
      <Link aria-current={active === "home" ? "page" : undefined} href="/home">Home</Link>
      <Link aria-current={active === "friends" ? "page" : undefined} href="/friends">Friends</Link>
      <Link aria-current={active === "albums" ? "page" : undefined} href="/albums">Albums</Link>
      <Link href="/groups">Manage groups</Link>
    </nav>
  );
}
