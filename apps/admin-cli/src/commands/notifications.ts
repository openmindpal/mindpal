/**
 * notifications 命令组 — 通知偏好 + 收件箱
 */
import { Command } from "commander";
import { resolveGlobalOptions, toApiOpts } from "../lib/globalOptions";
import { apiGet, apiPost, apiPut, qs } from "../lib/apiClient";
import { printResult } from "../lib/output";

export function registerNotificationsCommands(program: Command) {
  const notif = program.command("notifications").description("通知管理");

  const prefs = notif.command("prefs").description("通知偏好");

  prefs.command("get").description("获取通知偏好").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/notifications/preferences"), g.format);
  });

  prefs.command("set").description("更新通知偏好").option("--body-json <json>", "偏好 JSON").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    const body = _o.bodyJson ? JSON.parse(_o.bodyJson) : {};
    printResult(await apiPut(o, "/notifications/preferences", body), g.format);
  });

  const inbox = notif.command("inbox").description("通知收件箱");

  inbox.command("list").description("列出通知").option("--limit <n>").option("--offset <n>").option("--unread-only", "仅未读").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, `/notifications/inbox${qs({ limit: _o.limit, offset: _o.offset, unreadOnly: _o.unreadOnly })}`), g.format);
  });

  inbox.command("unread-count").description("未读数量").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiGet(o, "/notifications/inbox/unread-count"), g.format);
  });

  inbox.command("read <notificationId>").description("标记已读").action(async (notificationId, _o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, `/notifications/inbox/${encodeURIComponent(notificationId)}/read`), g.format);
  });

  inbox.command("read-all").description("标记全部已读").action(async (_o, cmd) => {
    const g = resolveGlobalOptions(cmd); const o = toApiOpts(g);
    printResult(await apiPost(o, "/notifications/inbox/read-all"), g.format);
  });
}
