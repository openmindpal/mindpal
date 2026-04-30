import fs from "node:fs/promises";
import path from "node:path";

const base = path.resolve("src", "app");
const files = [
  "HomeChat.tsx", "useChatSession.ts", "useTaskManager.ts",
  "useToolExecution.ts", "useSendMessage.ts", "useDirectives.ts",
  "useWorkspaceTabs.tsx", "useSplitLayout.ts",
];
const parts = await Promise.all(files.map((f) => fs.readFile(path.resolve(base, f), "utf8").catch(() => "")));
const code = parts.join("\n");

const checks = [
  ['case "toolSuggestions"', "ts_case"],
  ['it.kind === "toolSuggestions"', "ts_render"],
  ["import StatusBar from", "statusbar_import"],
  ["<StatusBar", "statusbar_jsx"],
  ["import RecentAndFavorites from", "recfav_import"],
  ["<RecentAndFavorites", "recfav_jsx"],
  ["ApprovalNodeRenderer", "approval_node"],
  ['kind: "artifact"', "artifact_kind"],
  ['kind: "runDetail"', "rundetail_kind"],
  ['kind: "approvalDetail"', "approvaldetail_kind"],
  ["ArtifactPreview", "artifact_preview"],
  ["import BottomTray from", "bottomtray_import"],
  ["<BottomTray", "bottomtray_jsx"],
  ["handleTabDragStart", "drag_start"],
  ["handleTabDragOver", "drag_over"],
  ["handleTabDrop", "drag_drop"],
  ["draggable", "draggable"],
  ["/orchestrator/dispatch/stream", "orch_stream"],
  ["toolSuggestions", "tool_suggestions"],
  ["executeToolInline", "exec_inline"],
  ["needs_approval", "needs_approval"],
  ["pollRunResult", "poll_run"],
  ["stepOutput", "step_output"],
  ["openInWorkspace", "open_ws"],
  ['kind: "artifact"', "artifact_ws_kind"],
  ["openslin_chat_session", "session_key"],
  ["openslin_workspace_tabs", "ws_key"],
  ["openslin_split_layout", "split_key"],
];

let ok = 0;
let fail = 0;
for (const [pat, name] of checks) {
  if (code.includes(pat)) {
    ok++;
    console.log(`  OK  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} => ${pat}`);
  }
}
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
