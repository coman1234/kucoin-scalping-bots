import type { Metadata } from "next";
import "./globals.css";
import { Inter } from "next/font/google";
import { JetBrains_Mono } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Day-Trader Bot C · v7",
  description: "Autonomous ATR/BB breakout day-trading dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className={`${inter.className} bg-white min-h-screen text-tv-text antialiased`}>
        {children}
      </body>
    </html>
  );
}
