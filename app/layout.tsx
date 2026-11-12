import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Assistant } from "./_components/assistant/assistant";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FairPrice",
  description:
    "Fair prices for digital products in every country, verified by PayPal at checkout.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Assistant />
      </body>
    </html>
  );
}
