import type { Metadata } from "next";
import "./globals.css";
import { TradingProvider } from "@/lib/context";

export const metadata: Metadata = {
  title: "Scalping Bot7",
  description: "KuCoin Scalping Bot — v7 (UCB1 Self-Learning)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <TradingProvider>{children}</TradingProvider>
      </body>
    </html>
  );
}
