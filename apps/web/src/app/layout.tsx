import type { Metadata } from "next";
import "@/styles/globals.css";
import { Providers } from './providers';
import { Toaster } from '@/shared/components/feedback';
import { VitalsReporter } from './VitalsReporter';

export const metadata: Metadata = {
  title: "灵智 MindPal",
  description: "面向企业与端侧的智能体底层操作系统",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <body className="min-h-dvh bg-[var(--color-surface)] text-[var(--color-text)] antialiased">
        <Providers>
          {children}
        </Providers>
        <Toaster />
        <VitalsReporter />
      </body>
    </html>
  );
}
