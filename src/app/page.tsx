import { ReconstructionDemo } from "@/components/reconstruction-demo";
import { getDemoFragments, getDemoMoments } from "@/lib/pipeline/demo-reconstruction";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="shell home-shell" id="main-content">
      <a className="skip-link" href="#demo-fragments">Skip to the memory demonstration</a>
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <span className="group-label">MEMORY ATLAS / SYNTHETIC DEMO</span>
        <nav className="top-actions" aria-label="Main navigation">
          <Link href="#atlas">Explore the demo</Link>
          <Link href="/groups">Group spaces</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>
      <section className="intro home-intro" id="atlas">
        <p className="eyebrow"><span className="eyebrow-mark" />A MEMORY, SEEN TOGETHER</p>
        <div className="home-intro-grid">
          <div>
            <h1>Little pieces.<br /><em>One shared afternoon.</em></h1>
            <p className="lede">
              Everyone remembers a moment differently. Between Us lays the fragments side by side
              and shows what connects — and what is still uncertain.
            </p>
            <div className="hero-actions">
              <Link className="primary-button link-button" href="/groups">Open your group spaces <span aria-hidden="true">↗</span></Link>
              <a className="text-button" href="#demo-fragments">See the fragments ↓</a>
            </div>
          </div>
          <aside className="hero-note" aria-label="Privacy promise">
            <span className="hero-note-icon" aria-hidden="true">✳</span>
            <p className="hero-note-label">A quieter kind of social</p>
            <p>Your group stays private. Members choose what to share, and AI suggestions are never treated as fact.</p>
            <span className="hero-note-foot">PRIVATE BY DEFAULT&nbsp; · &nbsp;MEMBER-LED</span>
          </aside>
        </div>
      </section>
      <div className="demo-heading" id="demo-fragments" tabIndex={-1}>
        <div>
          <p className="eyebrow">FIELD NOTE 01 / SEPTEMBER 04</p>
          <h2>The cafeteria crew</h2>
        </div>
        <span className="demo-data-label"><span /> Synthetic demo data</span>
      </div>
      <ReconstructionDemo initialFragments={getDemoFragments()} initialMoment={getDemoMoments()[0] ?? null} />
      <footer className="footer-note">
        <span>BETWEEN US <span aria-hidden="true">✳</span></span>
        <span>Candidate memories stay uncertain until people review them.</span>
      </footer>
    </main>
  );
}