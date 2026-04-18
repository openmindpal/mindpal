/**
 * smtpRepo.ts — SMTP 连接器配置（统一表代理）
 *
 * 底层使用 connector_configs 统一表，此文件提供 SMTP 类型化适配层。
 * 新代码建议直接使用 connectorConfigRepo.ts。
 */
import type { Pool, PoolClient } from "pg";
import { upsertConnectorConfig, getConnectorConfig } from "./connectorConfigRepo";

type Q = Pool | PoolClient;

export type SmtpConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  fromAddress: string;
  createdAt: string;
  updatedAt: string;
};

function fromConfig(row: { connectorInstanceId: string; tenantId: string; config: Record<string, unknown>; createdAt: string; updatedAt: string }): SmtpConnectorConfigRow {
  return {
    connectorInstanceId: row.connectorInstanceId,
    tenantId: row.tenantId,
    host: String(row.config.host ?? ""),
    port: Number(row.config.port ?? 0),
    useTls: Boolean(row.config.useTls),
    username: String(row.config.username ?? ""),
    passwordSecretId: String(row.config.passwordSecretId ?? ""),
    fromAddress: String(row.config.fromAddress ?? ""),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertSmtpConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  fromAddress: string;
}) {
  const row = await upsertConnectorConfig({
    pool: params.pool,
    connectorInstanceId: params.connectorInstanceId,
    tenantId: params.tenantId,
    typeName: "mail.smtp",
    config: {
      host: params.host,
      port: params.port,
      useTls: params.useTls,
      username: params.username,
      passwordSecretId: params.passwordSecretId,
      fromAddress: params.fromAddress,
    },
  });
  return fromConfig(row);
}

export async function getSmtpConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const row = await getConnectorConfig({ pool: params.pool, tenantId: params.tenantId, connectorInstanceId: params.connectorInstanceId });
  if (!row || row.typeName !== "mail.smtp") return null;
  return fromConfig(row);
}
