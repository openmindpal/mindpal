/**
 * 托盘跨平台桌面通知模块
 */
import { safeError, safeLog } from "../log";

export function showDesktopNotification(title: string, message: string): void {
  import("child_process").then(({ exec }) => {
    if (process.platform === "win32") {
      const ps = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null; $t=[Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]; $xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); $text=$xml.GetElementsByTagName('text'); $text.Item(0).AppendChild($xml.CreateTextNode('${title.replace(/'/g, "''")} - ${message.replace(/'/g, "''")}')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('灵智Mindpal').Show($t::new($xml))`;
      exec(`powershell -Command "${ps}"`, (err) => {
        if (err) {
          exec(`msg %username% "${title}: ${message}"`);
        }
      });
    } else if (process.platform === "darwin") {
      exec(`osascript -e 'display notification "${message}" with title "${title}"'`);
    } else {
      exec(`notify-send "${title}" "${message}"`);
    }
  });
}

export function showConfirmDialog(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    import("child_process").then(({ exec }) => {
      if (process.platform === "win32") {
        const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${message.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', 'YesNo', 'Warning')`;
        exec(`powershell -Command "${ps}"`, { timeout: 30000 }, (err, stdout) => {
          if (err) {
            safeError(`[托盘确认] 弹窗失败: ${err.message}, 默认拒绝`);
            resolve(false);
            return;
          }
          const result = stdout.trim().toLowerCase();
          safeLog(`[托盘确认] 用户选择: ${result}`);
          resolve(result === "yes");
        });
      } else if (process.platform === "darwin") {
        const script = `osascript -e 'display dialog "${message}" with title "${title}" buttons {"拒绝", "确认"} default button "拒绝" with icon caution'`;
        exec(script, { timeout: 30000 }, (err, stdout) => {
          resolve(!err && stdout.includes("确认"));
        });
      } else {
        exec(`zenity --question --title="${title}" --text="${message}" --timeout=30`, { timeout: 35000 }, (err) => {
          resolve(!err);
        });
      }
    });
  });
}

export function openDirectory(dirPath: string): void {
  import("child_process").then(({ exec }) => {
    if (process.platform === "win32") {
      exec(`explorer "${dirPath}"`);
    } else if (process.platform === "darwin") {
      exec(`open "${dirPath}"`);
    } else {
      exec(`xdg-open "${dirPath}"`);
    }
  });
}
