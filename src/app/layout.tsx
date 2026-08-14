import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Forge — Autonomous Software Factory",
  description: "A multi-agent AI software factory that turns a product spec into a real, deployable, working software product. Architect designs, Guardian guards, Reviewer reviews, Implementation agents build — verified end-to-end.",
  keywords: ["Forge", "AI software factory", "multi-agent", "LLM orchestration", "autonomous coding", "architecture guardian", "production readiness"],
  authors: [{ name: "Forge" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Forge — Autonomous Software Factory",
    description: "Multi-agent AI platform that builds real software from a spec, end-to-end.",
    url: "https://chat.z.ai",
    siteName: "Forge",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Forge — Autonomous Software Factory",
    description: "Multi-agent AI platform that builds real software from a spec, end-to-end.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
