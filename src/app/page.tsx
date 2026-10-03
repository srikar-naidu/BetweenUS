import { ReconstructionDemo } from "@/components/reconstruction-demo";
import { getDemoFragments, getDemoMoments } from "@/lib/pipeline/demo-reconstruction";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="/">between us<span>.</span></a>
        <span className="group-label">DEMO GROUP / THE CAFETERIA CREW</span>
        <nav className="top-actions" aria-label="Account">
          <Link href="/groups">Group spaces</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>
      <section className="intro">
        <p className="eyebrow">SHARED MEMORY / SEPTEMBER 04</p>
        <h1>One afternoon,<br />from a few fragments.</h1>
        <p className="lede">A cafeteria afternoon, pieced together from what each person happened to save.</p>
      </section>
      <ReconstructionDemo initialFragments={getDemoFragments()} initialMoment={getDemoMoments()[0] ?? null} />
      <footer className="footer-note">Synthetic demo data · candidate memories remain uncertain until reviewed</footer>
    </main>
  );
}