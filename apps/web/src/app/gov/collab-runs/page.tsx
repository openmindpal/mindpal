import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import CollabRunsClient from "./ui";

export default async function GovCollabRunsPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await Promise.resolve(props.searchParams);
  const locale = pickLocale(searchParams);
  const taskId = (Array.isArray(searchParams.taskId) ? searchParams.taskId[0] : searchParams.taskId) ?? "";
  return <CollabRunsClient locale={locale} initialTaskId={taskId} />;
}
