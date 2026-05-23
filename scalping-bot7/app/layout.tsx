import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { TradingProvider } from "@/lib/context";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "KuCoin Scalping Bot 7",
  description: "Professional cryptocurrency scalping bot — v7",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className}>
        <TradingProvider>{children}</TradingProvider>
      </body>
    </html>
  );
}
