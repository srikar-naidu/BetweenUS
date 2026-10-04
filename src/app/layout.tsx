import type { Metadata } from "next";
import { Barlow_Semi_Condensed, Martian_Mono } from "next/font/google";
import Link from "next/link";
import { MemoryNavigation } from "@/components/memory-navigation";
import { StoryAudioControls } from "@/components/story-audio-controls";
import "./globals.css";

const displayFont = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const monoFont = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Between Us",
  description: "A private shared memory system",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${displayFont.variable} ${monoFont.variable}`}>
      <body>
        <header className="topbar memory-site-header">
          <Link className="wordmark" href="/">between us<span>.</span></Link>
          <MemoryNavigation />
        </header>
        {children}
        <StoryAudioControls />
      </body>
    </html>
  );
}