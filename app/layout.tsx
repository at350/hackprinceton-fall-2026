import type { Metadata } from "next";
import { Geist } from "next/font/google";
import localFont from "next/font/local";
import { PRODUCT_NAME } from "@/lib/config";
import "./globals.css";

// Switzer (Fontshare, ITF Free Font License), self-hosted so the demo works offline.
const switzer = localFont({
  src: [
    { path: "./fonts/Switzer-400.woff2", weight: "400" },
    { path: "./fonts/Switzer-500.woff2", weight: "500" },
    { path: "./fonts/Switzer-600.woff2", weight: "600" },
  ],
  variable: "--font-switzer",
  display: "swap",
});

// Geist for headlines (the verdict and wordmark), the pairing Alpine Bio uses
// over Switzer text. next/font downloads it at build time and serves it locally.
const geist = Geist({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-geist", display: "swap" });

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · Bleed screening`,
  description: "Handheld brain-bleed screener dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${switzer.variable} ${geist.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
