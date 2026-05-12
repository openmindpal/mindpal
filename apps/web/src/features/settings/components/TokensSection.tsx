"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Skeleton } from "@/shared/components/primitives/Skeleton";

interface TokenItem {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  spaceId: string | null;
}

const EXPIRY_OPTIONS = [
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
  { value: "never", label: "永不过期" },
] as const;

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function TokensSection() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const { data, isLoading } = useQuery<{ items: TokenItem[] }>({
    queryKey: ["auth", "tokens"],
    queryFn: async () => {
      const res = await apiFetch("/auth/tokens");
      if (!res.ok) throw new Error(`获取令牌列表失败 (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: async (params: { name: string; expiresAt: string | null }) => {
      const res = await apiFetch("/auth/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: params.name, expiresAt: params.expiresAt }),
      });
      if (!res.ok) throw new Error(`创建令牌失败 (${res.status})`);
      return res.json() as Promise<{ tokenId: string; token: string; expiresAt: string | null }>;
    },
    onSuccess: (result) => {
      setCreatedToken(result.token);
      setShowForm(false);
      setTokenName("");
      setExpiryDays("30");
      setError("");
      qc.invalidateQueries({ queryKey: ["auth", "tokens"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (tokenId: string) => {
      const res = await apiFetch(`/auth/tokens/${tokenId}/revoke`, { method: "POST" });
      if (!res.ok) throw new Error(`撤销令牌失败 (${res.status})`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "tokens"] }),
    onError: (err: Error) => setError(err.message),
  });

  // 创建成功后自动复制到剪贴板
  useEffect(() => {
    if (createdToken) {
      navigator.clipboard.writeText(createdToken).then(() => setCopied(true)).catch(() => setCopied(false));
    } else {
      setCopied(false);
    }
  }, [createdToken]);

  const handleCreate = () => {
    if (!tokenName.trim()) { setError("请输入令牌名称"); return; }
    setError("");
    const expiresAt = expiryDays === "never"
      ? null
      : new Date(Date.now() + Number(expiryDays) * 86400000).toISOString();
    createMutation.mutate({ name: tokenName.trim(), expiresAt });
  };

  const handleRevoke = (id: string) => {
    if (!confirm("确定要撤销此令牌吗？撤销后不可恢复。")) return;
    revokeMutation.mutate(id);
  };

  const activeTokens = data?.items?.filter((t) => !t.revokedAt) ?? [];
  const revokedTokens = data?.items?.filter((t) => t.revokedAt) ?? [];

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium text-[var(--color-text)]">API 令牌</h2>
        <Button size="sm" variant="secondary" onClick={() => { setShowForm(!showForm); setCreatedToken(null); setError(""); }}>
          {showForm ? "取消" : "创建令牌"}
        </Button>
      </div>

      {/* 新创建的令牌显示 */}
      {createdToken && (
        <div className="mb-4 rounded-md border border-[#22c55e40] bg-[#22c55e10] p-3">
          <p className="mb-1 text-sm font-medium text-[#16a34a]">令牌已创建（请立即复制，关闭后无法再次查看）</p>
          <code className="block break-all rounded bg-[var(--color-surface-sunken)] p-2 text-xs text-[var(--color-text)]">
            {createdToken}
          </code>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(createdToken); setCopied(true); }}>
              复制令牌
            </Button>
            {copied && <span className="text-xs text-[#16a34a]">✓ 已自动复制到剪贴板</span>}
          </div>
        </div>
      )}

      {/* 创建表单 */}
      {showForm && (
        <div className="mb-4 space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
          <div>
            <label className="mb-1 block text-sm text-[var(--color-text-secondary)]">令牌名称</label>
            <Input
              placeholder="例如：CI/CD 部署"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              className="max-w-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-[var(--color-text-secondary)]">有效期</label>
            <select
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-[#dc2626]">{error}</p>}
          <Button size="sm" loading={createMutation.isPending} onClick={handleCreate}>
            确认创建
          </Button>
        </div>
      )}

      {/* 令牌列表 */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : activeTokens.length === 0 && revokedTokens.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">暂无令牌</p>
      ) : (
        <div className="space-y-2">
          {activeTokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--color-text)]">{t.name || "未命名令牌"}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  创建: {formatDate(t.createdAt)}
                  {t.expiresAt && <> · 过期: {formatDate(t.expiresAt)}</>}
                  {t.lastUsedAt && <> · 最近使用: {formatDate(t.lastUsedAt)}</>}
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={() => handleRevoke(t.id)} loading={revokeMutation.isPending}>
                撤销
              </Button>
            </div>
          ))}
          {revokedTokens.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">已撤销 ({revokedTokens.length})</summary>
              <div className="mt-1 space-y-1">
                {revokedTokens.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 opacity-50">
                    <div>
                      <p className="text-sm text-[var(--color-text)]">{t.name || "未命名令牌"}</p>
                      <p className="text-xs text-[var(--color-text-muted)]">已撤销: {formatDate(t.revokedAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
