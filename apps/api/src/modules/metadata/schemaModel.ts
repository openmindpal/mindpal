import { z } from "zod";

export const i18nTextSchema = z.record(z.string(), z.string());

export const fieldDefSchema = z.object({
  type: z.enum(["string", "number", "boolean", "json", "datetime", "reference"]),
  required: z.boolean().optional(),
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  /** For type=="reference": the target entity name (e.g. "customer") */
  referenceEntity: z.string().min(1).optional(),
  /** Vendor extensions keyed by namespace (e.g. "io.openslin.ui") */
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const entityDefSchema = z.object({
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  fields: z.record(z.string(), fieldDefSchema),
});

export const schemaDefSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().optional(),
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  entities: z.record(z.string(), entityDefSchema),
});

export type SchemaDef = z.infer<typeof schemaDefSchema>;

