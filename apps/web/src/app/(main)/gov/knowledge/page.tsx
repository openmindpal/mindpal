"use client";

export const dynamic = 'force-dynamic';

import Link from "next/link";
import { FileText, Search, Cpu, BarChart3 } from "lucide-react";

const cards = [
  {
    title: "文档管理",
    description: "管理知识库文档，查看摄入状态和来源类型",
    icon: FileText,
    href: "/gov/knowledge/documents",
  },
  {
    title: "检索策略",
    description: "配置和管理知识检索策略，优化召回效果",
    icon: Search,
    href: "/gov/knowledge/retrieval",
  },
  {
    title: "向量化配置",
    description: "管理 Embedding 模型配置和向量化任务",
    icon: Cpu,
    href: "/gov/knowledge/embedding",
  },
  {
    title: "质量评估",
    description: "创建和运行知识检索质量评估集",
    icon: BarChart3,
    href: "/gov/knowledge/quality",
  },
];

export default function KnowledgePage() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
          知识引擎
        </h1>
        <p className="mt-1 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
          管理知识库文档、检索策略、向量化配置与质量评估
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
