import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerAuthCommands(parent: Command) {
  const cmd = parent.command("auth").description("认证与令牌管理");

  /* ─── tokens ─── */
  const tokens = cmd.command("tokens").description("API 令牌管理");

  tokens.command("list").description("列出令牌").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/auth/tokens"), g.format);
  });

  tokens.command("create").description("创建令牌")
    .option("--name <name>", "令牌名称").option("--scope <scope>", "权限范围").option("--expires-in <sec>", "过期时间(秒)")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/tokens", { name: o.name, scope: o.scope, expiresIn: o.expiresIn ? Number(o.expiresIn) : undefined }), g.format);
    });

  tokens.command("revoke").description("撤销令牌").requiredOption("--token-id <id>", "令牌 ID")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, `/auth/tokens/${encodeURIComponent(o.tokenId)}/revoke`), g.format);
    });

  tokens.command("refresh").description("刷新令牌").option("--refresh-token <token>", "刷新令牌")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/tokens/refresh", { refreshToken: o.refreshToken }), g.format);
    });

  /* ─── MFA ─── */
  const mfa = cmd.command("mfa").description("多因素认证");

  mfa.command("enroll").description("注册 MFA").option("--method <method>", "MFA 方式 (totp|sms|email)")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/mfa/enroll", { method: o.method }), g.format);
    });

  mfa.command("confirm").description("确认 MFA 注册").requiredOption("--code <code>", "验证码")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/mfa/confirm", { code: o.code }), g.format);
    });

  mfa.command("verify").description("验证 MFA").requiredOption("--code <code>", "验证码")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/mfa/verify", { code: o.code }), g.format);
    });

  mfa.command("recovery").description("MFA 恢复").requiredOption("--recovery-code <code>", "恢复码")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/mfa/recovery", { recoveryCode: o.recoveryCode }), g.format);
    });

  mfa.command("status").description("查看 MFA 状态").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiGet(api, "/auth/mfa/status"), g.format);
  });

  mfa.command("disable").description("禁用 MFA").action(async function (this: Command) {
    const g = resolveGlobalOptions(this); const api = toApiOpts(g);
    printResult(await apiPost(api, "/auth/mfa/disable"), g.format);
  });

  /* ─── SSO ─── */
  const sso = cmd.command("sso").description("单点登录");

  sso.command("initiate").description("发起 SSO 登录").option("--provider <provider>", "SSO 提供商")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiPost(api, "/auth/sso/initiate", { provider: o.provider }), g.format);
    });

  sso.command("callback").description("SSO 回调").option("--code <code>", "授权码").option("--state <state>", "状态码")
    .action(async function (this: Command) {
      const g = resolveGlobalOptions(this); const api = toApiOpts(g); const o = this.opts();
      printResult(await apiGet(api, `/auth/sso/callback${qs({ code: o.code, state: o.state })}`), g.format);
    });
}
