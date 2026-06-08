import type { Metadata } from "next";
import { DM_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { QueryProvider } from "@/providers/QueryProvider";
import "./globals.css";

const dmMono = DM_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Agent Workspace",
  description: "Multi-agent collaboration workspace",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className={cn("font-sans", dmMono.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
