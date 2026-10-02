import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Between Us",
  description: "A private shared memory system",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}