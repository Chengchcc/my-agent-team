import type { Metadata } from "next";
import { ShellProvider } from "@/components/ShellProvider";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Observatory — Agent Workspace",
  description: "Multi-agent collaboration workspace",
};

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ShellProvider>
      <AppShell>{children}</AppShell>
    </ShellProvider>
  );
}
