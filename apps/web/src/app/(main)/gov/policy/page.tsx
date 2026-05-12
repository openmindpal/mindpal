"use client";

import Link from "next/link";
import { Camera, GitBranch } from "lucide-react";

const cards = [
  {
    title: "策略快照",
    description: "查看策略决策快照记录，追溯决策历史",
    icon: Camera,
    href: "/gov/policy/snapshots",
  },
  {
    title: "策略版本",
    description: "管理策略版本的创建、发布与弃用",
    icon: GitBranch,
    href: "/gov/policy/versions",
  },
];

export default function PolicyPage() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
          策略管理
        </h1>
        <p className="mt-1 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
          管理策略快照与策略版本生命周期
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5 transition-all duration-[var(--duration-fast)] hover:border-[var(--color-primary)] hover:shadow-md"
          >
            <card.icon className="h-8 w-8 text-[var(--color-primary)] transition-transform group-hover:scale-110" />
            <h2 className="text-[var(--text-base)] font-medium text-[var(--color-text)]">
              {card.title}
            </h2>
            <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">
              {card.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
