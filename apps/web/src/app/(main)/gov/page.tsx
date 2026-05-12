"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  GitPullRequest,
  AlertTriangle,
  Monitor,
  Database,
  GitBranch,
  Shield,
  Wrench,
  BookOpen,
  Scale,
  Globe,
  Plug,
  Settings,
  Activity,
  Layout,
  Cpu,
  Users,
  FlaskConical,
  FileCheck,
  Bot,
  Radio,
  Route,
  Zap,
  Smartphone,
  LayoutDashboard,
  Bell,
  CheckCircle,
  AlertOctagon,
  ScrollText,
  RefreshCw,
  GitMerge,
  Search,
  HardDrive,
  Cog,
  Package,
  Key,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import { cn } from "@/shared/lib/cn";
import { apiFetch } from "@/shared/lib/api";

/* ─── System Status Types ─── */
interface SystemStatus {
  pendingApprovals: number;
  activeChangesets: number;
  abnormalNodes: number;
  onlineDevices: number;
}

/* ─── Metric Card ─── */
interface MetricCardProps {
  label: string;
  value: number | undefined;
  isLoading: boolean;
  icon: LucideIcon;
  color: string;
}

function MetricCard({ label, value, isLoading, icon: Icon, color }: MetricCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", color)}>
        <Icon className="h-5 w-5 text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-[var(--color-text-secondary)]">{label}</p>
        {isLoading ? (
          <Skeleton className="mt-1 h-6 w-12" />
        ) : (
          <p className="text-xl font-semibold text-[var(--color-text)]">{value ?? 0}</p>
        )}
      </div>
    </div>
  );
}

/* ─── Nav Card ─── */
interface NavItem {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
}

function NavCard({ icon: Icon, title, description, href }: NavItem) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:bg-[var(--color-surface-sunken)]"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-sunken)]">
        <Icon className="h-5 w-5 text-[var(--color-text-secondary)]" />
      </div>
      <div className="min-w-0">
        <p className="font-medium text-[var(--color-text)]">{title}</p>
        <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{description}</p>
      </div>
    </Link>
  );
}

/* ─── Navigation Items ─── */
const navItems: NavItem[] = [
  { icon: Database, title: "数据模型", description: "Schema 定义与版本管理", href: "/gov/schemas" },
  { icon: GitBranch, title: "变更集", description: "变更发布与审批流程", href: "/gov/changesets" },
  { icon: Shield, title: "安全策略", description: "内容安全与注入防护", href: "/gov/safety-policies" },
  { icon: Wrench, title: "工具治理", description: "工具启禁与网络策略", href: "/gov/tools" },
  { icon: BookOpen, title: "知识引擎", description: "文档管理与检索策略", href: "/gov/knowledge" },
  { icon: Scale, title: "策略管理", description: "访问策略与决策快照", href: "/gov/policy" },
  { icon: Globe, title: "联邦管理", description: "跨节点互联与权限", href: "/gov/federation" },
  { icon: Plug, title: "集成管理", description: "OAuth与外部服务", href: "/gov/integrations" },
  { icon: Settings, title: "配置治理", description: "系统配置与覆盖", href: "/gov/config" },
  { icon: Activity, title: "可观测性", description: "系统监控与操作日志", href: "/gov/observability" },
  { icon: Layout, title: "UI 组件", description: "组件注册表管理", href: "/gov/ui" },
  { icon: Cpu, title: "Skill 运行时", description: "Runner 节点管理", href: "/gov/skill-runtime" },
  { icon: Users, title: "协作诊断", description: "多智能体运行诊断", href: "/gov/collab" },
  { icon: FlaskConical, title: "评估管理", description: "测试套件与回归", href: "/gov/evals" },
  { icon: FileCheck, title: "工件策略", description: "工件审查规则", href: "/gov/artifact-policy" },
  { icon: Bot, title: "模型管理", description: "模型配置与版本管理", href: "/gov/models" },
  { icon: Radio, title: "渠道管理", description: "IM渠道与Webhook配置", href: "/gov/channels" },
  { icon: Route, title: "模型路由", description: "路由策略与调度", href: "/gov/routing" },
  { icon: Zap, title: "触发器", description: "定时与事件触发管理", href: "/gov/triggers" },
  { icon: Smartphone, title: "设备管理", description: "设备配对与状态", href: "/gov/devices" },
  { icon: LayoutDashboard, title: "工作台", description: "工作台配置管理", href: "/gov/workbenches" },
  { icon: Bell, title: "通知管理", description: "通知配置与收件箱", href: "/gov/notifications" },
  { icon: CheckCircle, title: "审批管理", description: "审批工单与流程", href: "/gov/approvals" },
  { icon: AlertOctagon, title: "死信队列", description: "工作流异常恢复", href: "/gov/workflow/deadletters" },
  { icon: ScrollText, title: "审计日志", description: "操作审计与追溯", href: "/gov/audit" },
  { icon: RefreshCw, title: "数据同步", description: "离线同步管理", href: "/gov/sync" },
  { icon: GitMerge, title: "同步冲突", description: "冲突检测与解决", href: "/gov/sync-conflicts" },
  { icon: Search, title: "检索日志", description: "知识检索追踪", href: "/gov/knowledge/retrieval-logs" },
  { icon: HardDrive, title: "摄入任务", description: "知识摄入与索引", href: "/gov/knowledge/jobs" },
  { icon: Cog, title: "检索引擎", description: "检索策略配置", href: "/gov/knowledge/engine" },
  { icon: Package, title: "Skill 包", description: "技能包注册与版本", href: "/gov/skill-packages" },
  { icon: Key, title: "凭证管理", description: "密钥凭证生命周期管理", href: "/gov/secrets" },
  { icon: Plug, title: "连接器管理", description: "连接器实例与出站策略", href: "/gov/connectors" },
];

/* ─── Page Component ─── */
export default function GovPage() {
  const { data, isLoading } = useQuery<SystemStatus>({
    queryKey: ["governance", "system-status"],
    queryFn: async () => {
      const res = await apiFetch("/governance/system-status");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<SystemStatus>;
    },
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">治理控制台</h1>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label="待审批数"
          value={data?.pendingApprovals}
          isLoading={isLoading}
          icon={ClipboardCheck}
          color="bg-yellow-500"
        />
        <MetricCard
          label="活跃变更集"
          value={data?.activeChangesets}
          isLoading={isLoading}
          icon={GitPullRequest}
          color="bg-blue-500"
        />
        <MetricCard
          label="异常节点"
          value={data?.abnormalNodes}
          isLoading={isLoading}
          icon={AlertTriangle}
          color="bg-red-500"
        />
        <MetricCard
          label="在线设备"
          value={data?.onlineDevices}
          isLoading={isLoading}
          icon={Monitor}
          color="bg-green-500"
        />
      </div>

      {/* Navigation Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {navItems.map((item) => (
          <NavCard key={item.href} {...item} />
        ))}
      </div>
    </div>
  );
}
