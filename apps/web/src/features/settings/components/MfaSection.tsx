"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Skeleton } from "@/shared/components/primitives/Skeleton";

interface MfaStatus {
  enrolled: boolean;
  verified: boolean;
  method: string | null;
  recoveryCodesRemaining: number;
}

interface EnrollResult {
  totpUri: string;
  secret: string;
  recoveryCodes: string[];
}

export function MfaSection() {
  const qc = useQueryClient();
  const [enrollData, setEnrollData] = useState<EnrollResult | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { data: status, isLoading } = useQuery<MfaStatus>({
    queryKey: ["auth", "mfa", "status"],
    queryFn: async () => {
      const res = await apiFetch("/auth/mfa/status");
      if (!res.ok) throw new Error(`获取 MFA 状态失败 (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/auth/mfa/enroll", { method: "POST" });
      if (!res.ok) throw new Error(`启用 MFA 失败 (${res.status})`);
      return res.json() as Promise<EnrollResult>;
    },
    onSuccess: (result) => {
      setEnrollData(result);
      setError("");
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiFetch("/auth/mfa/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error(`验证码错误或已过期 (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      setSuccess("MFA 已成功启用");
      setEnrollData(null);
      setConfirmCode("");
      setError("");
      qc.invalidateQueries({ queryKey: ["auth", "mfa", "status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const disableMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiFetch("/auth/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error(`禁用 MFA 失败，验证码错误 (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      setSuccess("MFA 已禁用");
      setShowDisable(false);
      setDisableCode("");
      setError("");
      qc.invalidateQueries({ queryKey: ["auth", "mfa", "status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleConfirm = () => {
    if (!confirmCode.trim()) { setError("请输入验证码"); return; }
    setError("");
    confirmMutation.mutate(confirmCode.trim());
  };

  const handleDownloadRecoveryCodes = useCallback(() => {
    if (!enrollData) return;
    const content = enrollData.recoveryCodes.join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mfa-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [enrollData]);

  const handleDisable = () => {
    if (!disableCode.trim()) { setError("请输入验证码"); return; }
    setError("");
    disableMutation.mutate(disableCode.trim());
  };

  const mfaEnabled = status?.enrolled && status?.verified;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <h2 className="mb-4 text-base font-medium text-[var(--color-text)]">安全设置</h2>

      {isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <div className="space-y-4">
          {/* MFA 状态 */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[var(--color-text)]">多因素认证 (MFA)</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {mfaEnabled
                  ? `已启用 · TOTP · 剩余恢复码: ${status?.recoveryCodesRemaining ?? 0}`
                  : "未启用 — 建议启用以增强账户安全"}
              </p>
            </div>
            {!mfaEnabled && !enrollData && (
              <Button size="sm" variant="secondary" loading={enrollMutation.isPending} onClick={() => { setError(""); setSuccess(""); enrollMutation.mutate(); }}>
                启用 MFA
              </Button>
            )}
            {mfaEnabled && !showDisable && (
              <Button size="sm" variant="danger" onClick={() => { setShowDisable(true); setError(""); setSuccess(""); }}>
                禁用 MFA
              </Button>
            )}
          </div>

          {/* 注册流程 */}
          {enrollData && (
            <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
              {/* QR 码展示 */}
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-[var(--color-text-secondary)]">使用验证器应用扫描以下二维码：</p>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(enrollData.totpUri)}`}
                  alt="TOTP QR Code"
                  width={200}
                  height={200}
                  className="rounded-md border border-[var(--color-border)] bg-white p-2"
                />
              </div>
              {/* 备用文本密钥 */}
              <div className="text-center">
                <p className="text-xs text-[var(--color-text-muted)] mb-1">或手动输入密钥：</p>
                <code className="inline-block break-all rounded bg-[var(--color-surface-0)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-mono text-[var(--color-text)]">
                  {enrollData.secret}
                </code>
              </div>
              <div>
                <label className="mb-1 block text-sm text-[var(--color-text-secondary)]">输入验证器生成的 6 位验证码</label>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="000000"
                    value={confirmCode}
                    onChange={(e) => setConfirmCode(e.target.value)}
                    maxLength={6}
                    className="w-32"
                  />
                  <Button size="sm" loading={confirmMutation.isPending} onClick={handleConfirm}>
                    确认绑定
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEnrollData(null); setError(""); }}>
                    取消
                  </Button>
                </div>
              </div>
              {/* 恢复码 */}
              <div className="mt-2">
                <p className="text-xs font-medium text-[var(--color-text-secondary)]">恢复码（请安全保存，仅显示一次）：</p>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {enrollData.recoveryCodes.map((code, i) => (
                    <code key={i} className="rounded bg-[var(--color-surface-0)] px-2 py-0.5 text-xs text-[var(--color-text)]">
                      {code}
                    </code>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={handleDownloadRecoveryCodes}
                >
                  ⬇ 下载恢复码
                </Button>
              </div>
            </div>
          )}

          {/* 禁用确认 */}
          {showDisable && (
            <div className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-4">
              <p className="text-sm text-[var(--color-text-secondary)]">输入当前验证码以禁用 MFA</p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="000000"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  maxLength={6}
                  className="w-32"
                />
                <Button size="sm" variant="danger" loading={disableMutation.isPending} onClick={handleDisable}>
                  确认禁用
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowDisable(false); setError(""); }}>
                  取消
                </Button>
              </div>
            </div>
          )}

          {/* 错误 / 成功提示 */}
          {error && <p className="text-sm text-[var(--color-danger-text)]">{error}</p>}
          {success && <p className="text-sm text-[var(--color-success-text)]">{success}</p>}
        </div>
      )}
    </section>
  );
}
