import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenYacht Node",
  description: "An OpenYacht federation node.",
  robots: { index: false, follow: false },
};

// System fonts on purpose: next/font/google downloads at build time, and a
// reference node should build with no third-party request.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="bg-background text-foreground flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
