/**
 * imapRepo.ts — IMAP 连接器配置（统一表代理）
 *
 * 底层使用 connector_configs 统一表，此文件提供 IMAP 类型化适配层。
 * 新代码建议直接使用 connectorConfigRepo.ts。
 */
import type { Pool, PoolClient } from "pg";
import { upsertConnectorConfig, getConnectorConfig } from "./connectorConfigRepo";

type Q = Pool | PoolClient;

export type ImapConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  mailbox: string;
  fetchWindowDays: number | null;
  createdAt: string;
  updatedAt: string;
};

function fromConfig(row: { connectorInstanceId: string; tenantId: string; config: Record<string, unknown>; createdAt: string; updatedAt: string }): ImapConnectorConfigRow {
  return {
    connectorInstanceId: row.connectorInstanceId,
    tenantId: row.tenantId,
    host: String(row.config.host ?? ""),
    port: Number(row.config.port ?? 0),
    useTls: Boolean(row.config.useTls),
    username: String(row.config.username ?? ""),
    passwordSecretId: String(row.config.passwordSecretId ?? ""),
    mailbox: String(row.config.mailbox ?? ""),
    fetchWindowDays: row.config.fetchWindowDays != null ? Number(row.config.fetchWindowDays) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertImapConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  passwordSecretId: string;
  mailbox: string;
  fetchWindowDays?: number | null;
}) {
  const row = await upsertConnectorConfig({
    pool: params.pool,
    connectorInstanceId: params.connectorInstanceId,
    tenantId: params.tenantId,
    typeName: "mail.imap",
    config: {
      host: params.host,
      port: params.port,
      useTls: params.useTls,
      username: params.username,
      passwordSecretId: params.passwordSecretId,
      mailbox: params.mailbox,
      fetchWindowDays: params.fetchWindowDays ?? null,
    },
  });
  return fromConfig(row);
}

export async function getImapConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const row = await getConnectorConfig({ pool: params.pool, tenantId: params.tenantId, connectorInstanceId: params.connectorInstanceId });
  if (!row || row.typeName !== "mail.imap") return null;
  return fromConfig(row);
}
