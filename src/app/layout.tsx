import type { Metadata, Viewport } from "next";
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
  title: "GTA: 罪恶都市 · Web 版（reVCDOS）",
  description:
    "参照 Lolendor/reVCDOS（MIT）的 Web 实现：WebAssembly 引擎 + Brotli 流式资源代理 + 云存档，打开即玩侠盗猎车手：罪恶都市。",
  keywords: [
    "reVCDOS",
    "GTA Vice City",
    "罪恶都市",
    "WebAssembly",
    "js-dos",
    "DOS Zone",
    "browser game",
  ],
  authors: [{ name: "reVCDOS Web" }],
  openGraph: {
    title: "GTA: 罪恶都市 · Web 版",
    description: "在浏览器中直接运行 GTA: Vice City（WebAssembly 移植版）",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
