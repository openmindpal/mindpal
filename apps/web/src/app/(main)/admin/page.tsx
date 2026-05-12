"use client";

import Link from "next/link";
import {
  Shield,
  Building,
  Network,
  UserCog,
  HardDrive,
  Key,
  type LucideIcon,
} from "lucide-react";

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
      className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-4 transition-shadow hover:shadow-md"
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
  { icon: Shield, title: "角色与权限", description: "RBAC 角色、权限和绑定管理", href: "/admin/rbac" },
  { icon: Building, title: "空间管理", description: "工作空间与成员配置", href: "/admin/spaces" },
  { icon: Network, title: "组织管理", description: "组织结构与层级管理", href: "/admin/organizations" },
  { icon: UserCog, title: "身份管理", description: "SCIM 用户与组同步", href: "/admin/scim" },
  { icon: HardDrive, title: "备份管理", description: "数据备份与恢复", href: "/admin/backups" },
  { icon: Key, title: "SSO 配置", description: "单点登录提供者", href: "/admin/sso" },
];

/* ─── Page Component ─── */
export default function AdminPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">管理后台</h1>

      {/* Navigation Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {navItems.map((item) => (
          <NavCard key={item.href} {...item} />
        ))}
      </div>
    </div>
  );
}
