import { API_BASE, apiHeaders, pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import { ConsoleShell } from "@/components/shell/ConsoleShell";
import TaskDetailClient from "./ui";
import { cookies } from "next/headers";

async function loadTask(locale: string, taskId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function loadMessages(locale: string, taskId: string) {
  const token = (await cookies()).get("openslin_token")?.value ?? "";
  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/messages?limit=50`, { headers: apiHeaders(locale, { token }), cache: "no-store" });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

export default async function TaskDetailPage(props: { params: { taskId: string }; searchParams: SearchParams | Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const taskId = decodeURIComponent(props.params.taskId);
  const taskRes = await loadTask(locale, taskId);
  const msgRes = await loadMessages(locale, taskId);
  return (
    <ConsoleShell locale={locale}>
      <TaskDetailClient locale={locale} taskId={taskId} initialTask={taskRes.json} initialTaskStatus={taskRes.status} initialMessages={msgRes.json} initialMessagesStatus={msgRes.status} />
    </ConsoleShell>
  );
}

