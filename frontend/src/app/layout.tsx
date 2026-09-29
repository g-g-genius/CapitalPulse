import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./workspace.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const themeInitScript = `(function(){var t='dark';try{t=localStorage.getItem('capitalpulse.theme')==='light'?'light':'dark'}catch(e){}document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.colorScheme=t})()`;

export const metadata: Metadata = {
  title: "A · Flow · 资金工作台",
  description: "A 股申万二级行业动态资金流榜单与短线异动雷达",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark" style={{ colorScheme: "dark" }} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
