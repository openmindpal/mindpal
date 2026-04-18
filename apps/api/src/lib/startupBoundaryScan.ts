/**
 * startupBoundaryScan.ts — 启动时模块边界自检
 *
 * 在 API 服务启动时扫描 kernel/ 目录下的源文件，
 * 检查是否存在违反模块边界规则的 import 语句。
 * 仅产出 warn/error 日志，不阻断启动。
 */
import fs from "node:fs";
import path from "node:path";
import { MODULE_BOUNDARY_RULES, checkBoundaryViolations, type BoundaryViolation } from "../kernel/moduleBoundary";

/**
 * 从 TypeScript 源文件中提取所有 import from 路径
 */
function extractImports(source: string): string[] {
  const imports: string[] = [];
  // 匹配 import ... from "xxx" 和 import "xxx"
  const regex = /(?:import\s+(?:[\s\S]*?)\s+from\s+|import\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    imports.push(m[1]);
  }
  // 匹配 require("xxx")
  const reqRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRegex.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/**
 * 递归收集目录下所有 .ts/.tsx 文件
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        results.push(...collectTsFiles(full));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
        results.push(full);
      }
    }
  } catch {
    // 目录不可读，跳过
  }
  return results;
}

export interface BoundaryScanResult {
  scannedFiles: number;
  violations: BoundaryViolation[];
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/**
 * 执行启动时模块边界扫描
 * @param srcRoot  apps/api/src 绝对路径
 */
export function runBoundaryScan(srcRoot: string): BoundaryScanResult {
  const violations: BoundaryViolation[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // 工作空间根目录（srcRoot 的上三级 apps/api/src → workspace root）
  const workspaceRoot = path.resolve(srcRoot, "..", "..", "..");

  // 扫描目标目录 — 覆盖 kernel/modules/skills/routes 四层
  const scanDirs = [
    path.join(srcRoot, "kernel"),
    path.join(srcRoot, "modules"),
    path.join(srcRoot, "skills"),
    path.join(srcRoot, "routes"),
  ];

  // 如果 packages/shared 也在范围内
  const sharedDir = path.join(workspaceRoot, "packages", "shared", "src");
  if (fs.existsSync(sharedDir)) {
    scanDirs.push(sharedDir);
  }

  let scannedFiles = 0;

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = collectTsFiles(dir);

    for (const file of files) {
      scannedFiles++;
      try {
        const source = fs.readFileSync(file, "utf-8");
        const imports = extractImports(source);
        // 计算相对于 workspace root 的路径
        const relPath = path.relative(workspaceRoot, file).replace(/\\/g, "/");
        const fileViolations = checkBoundaryViolations(relPath, imports);
        violations.push(...fileViolations);
      } catch {
        // 单文件读取失败不影响整体
      }
    }
  }

  for (const v of violations) {
    const msg = `[boundary] ${v.severity.toUpperCase()}: ${v.rule} — ${v.file} imports "${v.importPath}"`;
    if (v.severity === "error") {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }

  return {
    scannedFiles,
    violations,
    errors,
    warnings,
    ok: errors.length === 0,
  };
}

/**
 * 格式化违规报告，便于启动日志输出
 */
export function formatBoundaryScanReport(result: BoundaryScanResult): string {
  const lines: string[] = [
    `[BoundaryScan] scanned ${result.scannedFiles} files, ${result.violations.length} violations`,
  ];
  if (result.violations.length === 0) {
    lines.push("  ✓ No boundary violations detected.");
    return lines.join("\n");
  }
  // 按规则名分组
  const grouped = new Map<string, BoundaryViolation[]>();
  for (const v of result.violations) {
    const list = grouped.get(v.rule) ?? [];
    list.push(v);
    grouped.set(v.rule, list);
  }
  for (const [rule, items] of grouped) {
    const severity = items[0].severity.toUpperCase();
    lines.push(`  [${severity}] ${rule} (${items.length} violation${items.length > 1 ? "s" : ""})`);
    for (const item of items.slice(0, 5)) {
      lines.push(`    • ${item.file} → ${item.importPath}`);
    }
    if (items.length > 5) {
      lines.push(`    ... and ${items.length - 5} more`);
    }
  }
  lines.push(`  Summary: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return lines.join("\n");
}
