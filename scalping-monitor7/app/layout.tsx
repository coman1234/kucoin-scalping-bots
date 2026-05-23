import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { MonitorProvider } from "@/lib/monitorContext";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "TA Monitor — KuCoin Scalping",
  description: "Real-time technical analysis monitor",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className}>
        <MonitorProvider>{children}</MonitorProvider>
      </body>
    </html>
  );
}
