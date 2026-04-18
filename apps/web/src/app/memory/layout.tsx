import { ConsoleShell } from "@/components/shell/ConsoleShell";

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
