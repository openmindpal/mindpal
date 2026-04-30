"use client";

import type { SchemaUiConfig } from "@openslin/shared";
import { SchemaRenderer } from "../schema-ui/SchemaRenderer";

interface Props {
  config: SchemaUiConfig;
}

export default function FlowSchemaUiResult({ config }: Props) {
  return (
    <div style={{ width: "100%", marginBlock: 8 }}>
      <SchemaRenderer config={config} />
    </div>
  );
}
