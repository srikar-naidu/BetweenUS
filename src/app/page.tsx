import { ReconstructionDemo } from "@/components/reconstruction-demo";
import { getDemoFragments, getDemoMoments, getSampleDemoMoment } from "@/lib/pipeline/demo-reconstruction";
import Image from "next/image";
import Link from "next/link";
import { MemoryNavigation } from "@/components/memory-navigation";

export const dynamic = "force-dynamic";

export default function Home() {
  const reconstructedMoments = getDemoMoments();

  return (
    <main className="shell home-shell" id="main-content">
      <a className="skip-link" href="#demo-fragments">Skip to the memory demonstration</a>
      <header className="topbar">
        <Link className="wordmark" href="/">between us<span>.</span></Link>
        <MemoryNavigation active={null} />
      </header>
      <section className="intro home-intro" id="atlas">
        <p className="eyebrow"><span className="eyebrow-mark" />WHEN EVERYONE REMEMBERS A LITTLE DIFFERENTLY</p>
        <div className="home-intro-grid">
          <div className="home-copy">
            <h1>Four people.<br /><em>One afternoon.</em></h1>
            <p className="lede">
              Maya remembers the fries. Arjun remembers the rush. Leah caught everyone cheering.
              Between Us connects the little things you each remember — and leaves the final say to you.
            </p>
            <div className="hero-actions">
              <Link className="primary-button link-button" href="/groups">Start a private group <span aria-hidden="true">↗</span></Link>
            </div>
          </div>
          <aside className="hero-visual" aria-label="An illustrated shared afternoon, pieced together from friends&apos; memories">
            <div className="hero-scene">
              <Image
                className="hero-scene-image"
                src="/cafeteria-moment.svg"
                alt="Friends gathering around a cafeteria table with coffee and fries"
                width={720}
                height={600}
                priority
              />
              <div className="hero-memory-note hero-memory-note--top">
                <span>MAYA · 12:04</span>
                <strong>“I saved you a seat.”</strong>
              </div>
              <div className="hero-memory-note hero-memory-note--bottom">
                <span>THE LITTLE CLUES</span>
                <strong>Fries. Three coffees. One table.</strong>
              </div>
            </div>
            <p className="hero-visual-caption"><span>01 / 04</span> A shared afternoon, from everyone&apos;s angle.</p>
          </aside>
        </div>
      </section>
      <div className="demo-heading" id="demo-fragments" tabIndex={-1}>
        <div>
          <p className="eyebrow">A MEMORY, PIECED TOGETHER</p>
          <h2>One lunch. Four little clues.</h2>
        </div>
        <span className="demo-data-label"><span /> A sample reconstruction</span>
      </div>
      <ReconstructionDemo
        initialFragments={getDemoFragments()}
        initialMoment={reconstructedMoments[0] ?? getSampleDemoMoment()}
        initialMomentIsExample={reconstructedMoments.length === 0}
        enableLiveReconstruction={process.env.NODE_ENV === "development"}
      />
      <footer className="footer-note">
        <span>BETWEEN US <span aria-hidden="true">✳</span></span>
        <span>Little clues. A fuller story. Yours to decide.</span>
      </footer>
    </main>
  );
}