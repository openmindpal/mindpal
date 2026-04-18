/**
 * exchangeRepo.ts — Exchange 连接器配置（统一表代理）
 *
 * 底层使用 connector_configs 统一表，此文件提供 Exchange 类型化适配层。
 * 新代码建议直接使用 connectorConfigRepo.ts。
 */
import type { Pool, PoolClient } from "pg";
import { upsertConnectorConfig, getConnectorConfig } from "../../../modules/connectors/connectorConfigRepo";

type Q = Pool | PoolClient;

export type ExchangeConnectorConfigRow = {
  connectorInstanceId: string;
  tenantId: string;
  oauthGrantId: string;
  mailbox: string;
  fetchWindowDays: number | null;
  createdAt: string;
  updatedAt: string;
};

function fromConfig(row: { connectorInstanceId: string; tenantId: string; config: Record<string, unknown>; createdAt: string; updatedAt: string }): ExchangeConnectorConfigRow {
  return {
    connectorInstanceId: row.connectorInstanceId,
    tenantId: row.tenantId,
    oauthGrantId: String(row.config.oauthGrantId ?? ""),
    mailbox: String(row.config.mailbox ?? ""),
    fetchWindowDays: row.config.fetchWindowDays != null ? Number(row.config.fetchWindowDays) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertExchangeConnectorConfig(params: {
  pool: Q;
  connectorInstanceId: string;
  tenantId: string;
  oauthGrantId: string;
  mailbox: string;
  fetchWindowDays?: number | null;
}) {
  const row = await upsertConnectorConfig({
    pool: params.pool,
    connectorInstanceId: params.connectorInstanceId,
    tenantId: params.tenantId,
    typeName: "mail.exchange",
    config: {
      oauthGrantId: params.oauthGrantId,
      mailbox: params.mailbox,
      fetchWindowDays: params.fetchWindowDays ?? null,
    },
  });
  return fromConfig(row);
}

export async function getExchangeConnectorConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const row = await getConnectorConfig({ pool: params.pool, tenantId: params.tenantId, connectorInstanceId: params.connectorInstanceId });
  if (!row || row.typeName !== "mail.exchange") return null;
  return fromConfig(row);
}
