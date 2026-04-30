/**
 * Schema-UI Generator — 请求/响应类型定义
 */
import { z } from "zod";

/** POST /schema-ui/generate 请求体 */
export const schemaUiRequestSchema = z.object({
  userInput: z.string().min(1).max(2000),
  tenantId: z.string().min(1),
  userId: z.string().optional(),
  modelRef: z.string().min(3).optional(),
});
export type SchemaUiRequest = z.infer<typeof schemaUiRequestSchema>;

/** POST /schema-ui/save-page 请求体 */
export const schemaUiSavePageSchema = z.object({
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()),
});
export type SchemaUiSavePage = z.infer<typeof schemaUiSavePageSchema>;
