import { pickLocale } from "@/lib/api";
import type { SearchParams } from "@/lib/types";
import ModelGatewayClient from "./ui";

export default async function GovModelGatewayPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const locale = pickLocale(searchParams);
  return <ModelGatewayClient locale={locale} />;
}
