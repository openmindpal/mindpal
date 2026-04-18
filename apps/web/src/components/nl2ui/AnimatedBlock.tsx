"use client";

/**
 * AnimatedBlock — 基于 Framer Motion 的动效组件系统
 *
 * NL2UI 2.0 核心组件之一：
 * - 为 NL2UI 生成的 UI 块提供入场/退出/交互动画
 * - 支持列表项交错动画、布局过渡、拖拽排序
 * - 与 DynamicBlockRenderer 无缝集成
 */
import React, { useMemo } from "react";
import { motion, AnimatePresence, type Variants, type TargetAndTransition, type Easing } from "framer-motion";

// ─── 类型定义 ──────────────────────────────────────────────────

/** 动画预设名称 */
export type AnimationPreset =
  | "fade-in"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "scale-in"
  | "bounce-in"
  | "blur-in"
  | "flip-in"
  | "none";

/** 动画配置 */
export interface AnimationConfig {
  /** 入场动画预设 */
  preset?: AnimationPreset;
  /** 动画时长(秒) */
  duration?: number;
  /** 延迟(秒) */
  delay?: number;
  /** 缓动函数 */
  ease?: string | number[];
  /** 是否启用退出动画 */
  exitAnimation?: boolean;
  /** 列表中的交错延迟(秒) */
  staggerDelay?: number;
  /** 悬停效果 */
  hoverEffect?: "lift" | "glow" | "scale" | "none";
  /** 点击效果 */
  tapEffect?: "shrink" | "bounce" | "none";
}

/** AnimatedBlock 组件 props */
export interface AnimatedBlockProps {
  children: React.ReactNode;
  /** 动画配置 */
  animation?: AnimationConfig;
  /** 列表项索引 (用于交错动画) */
  index?: number;
  /** 唯一标识 (用于 AnimatePresence 追踪) */
  layoutId?: string;
  /** 是否可见 */
  visible?: boolean;
  /** 容器标签 */
  as?: "div" | "section" | "article" | "li";
  /** 样式 */
  className?: string;
  style?: React.CSSProperties;
  /** 点击回调 */
  onClick?: () => void;
}

// ─── 动画预设定义 ──────────────────────────────────────────────

const PRESET_VARIANTS: Record<AnimationPreset, { initial: TargetAndTransition; animate: TargetAndTransition; exit: TargetAndTransition }> = {
  "fade-in": {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  "slide-up": {
    initial: { opacity: 0, y: 24 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -16 },
  },
  "slide-down": {
    initial: { opacity: 0, y: -24 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 16 },
  },
  "slide-left": {
    initial: { opacity: 0, x: 24 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -16 },
  },
  "slide-right": {
    initial: { opacity: 0, x: -24 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 16 },
  },
  "scale-in": {
    initial: { opacity: 0, scale: 0.85 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.9 },
  },
  "bounce-in": {
    initial: { opacity: 0, scale: 0.3, y: 40 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.5 },
  },
  "blur-in": {
    initial: { opacity: 0, filter: "blur(8px)" },
    animate: { opacity: 1, filter: "blur(0px)" },
    exit: { opacity: 0, filter: "blur(4px)" },
  },
  "flip-in": {
    initial: { opacity: 0, rotateX: -90 },
    animate: { opacity: 1, rotateX: 0 },
    exit: { opacity: 0, rotateX: 90 },
  },
  "none": {
    initial: {},
    animate: {},
    exit: {},
  },
};

const HOVER_EFFECTS: Record<string, TargetAndTransition> = {
  lift: { y: -4, boxShadow: "0 8px 25px rgba(0,0,0,0.1)", transition: { duration: 0.2 } },
  glow: { boxShadow: "0 0 20px rgba(99,102,241,0.15)", transition: { duration: 0.2 } },
  scale: { scale: 1.02, transition: { duration: 0.2 } },
  none: {},
};

const TAP_EFFECTS: Record<string, TargetAndTransition> = {
  shrink: { scale: 0.97, transition: { duration: 0.1 } },
  bounce: { scale: 0.95, transition: { type: "spring", stiffness: 400, damping: 10 } },
  none: {},
};

// ─── AnimatedBlock 主组件 ─────────────────────────────────────

export function AnimatedBlock({
  children,
  animation,
  index = 0,
  layoutId,
  visible = true,
  as = "div",
  className,
  style,
  onClick,
}: AnimatedBlockProps) {
  const preset = animation?.preset ?? "fade-in";
  const duration = animation?.duration ?? 0.35;
  const delay = (animation?.delay ?? 0) + (index * (animation?.staggerDelay ?? 0));
  const ease = animation?.ease ?? "easeOut";
  const hoverEffect = animation?.hoverEffect ?? "none";
  const tapEffect = animation?.tapEffect ?? "none";

  const variants = useMemo(() => PRESET_VARIANTS[preset] ?? PRESET_VARIANTS["fade-in"]!, [preset]);

  const MotionComponent = motion[as] ?? motion.div;

  if (!visible) return null;

  return (
    <MotionComponent
      layout={!!layoutId}
      layoutId={layoutId}
      initial={variants.initial}
      animate={variants.animate}
      exit={animation?.exitAnimation !== false ? variants.exit : undefined}
      transition={{ duration, delay, ease: ease as Easing }}
      whileHover={hoverEffect !== "none" ? HOVER_EFFECTS[hoverEffect] : undefined}
      whileTap={tapEffect !== "none" ? TAP_EFFECTS[tapEffect] : undefined}
      className={className}
      style={{ ...style, willChange: "transform, opacity" }}
      onClick={onClick}
    >
      {children}
    </MotionComponent>
  );
}

// ─── AnimatedList — 列表交错动画容器 ──────────────────────────

export interface AnimatedListProps {
  children: React.ReactNode[];
  /** 动画预设 */
  preset?: AnimationPreset;
  /** 交错延迟 */
  staggerDelay?: number;
  /** 动画时长 */
  duration?: number;
  /** 悬停效果 */
  hoverEffect?: AnimationConfig["hoverEffect"];
  /** 容器样式 */
  className?: string;
  style?: React.CSSProperties;
}

export function AnimatedList({
  children,
  preset = "slide-up",
  staggerDelay = 0.06,
  duration = 0.3,
  hoverEffect = "none",
  className,
  style,
}: AnimatedListProps) {
  const containerVariant = useMemo<Variants>(() => ({
    hidden: {},
    visible: { transition: { staggerChildren: staggerDelay } },
  }), [staggerDelay]);

  const itemVariant = useMemo(() => {
    const presetDef = PRESET_VARIANTS[preset] ?? PRESET_VARIANTS["slide-up"]!;
    return {
      hidden: presetDef.initial,
      visible: { ...presetDef.animate, transition: { duration, ease: "easeOut" as const } },
    } satisfies Variants;
  }, [preset, duration]);

  return (
    <motion.div
      variants={containerVariant}
      initial="hidden"
      animate="visible"
      className={className}
      style={style}
    >
      {React.Children.map(children, (child, i) => (
        <motion.div
          key={i}
          variants={itemVariant}
          whileHover={hoverEffect !== "none" ? HOVER_EFFECTS[hoverEffect] : undefined}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}

// ─── AnimatedPresence — 条件渲染动画包装器 ────────────────────

export interface AnimatedPresenceWrapperProps {
  children: React.ReactNode;
  /** 是否可见 */
  visible: boolean;
  /** 动画预设 */
  preset?: AnimationPreset;
  /** 唯一key */
  presenceKey?: string;
}

export function AnimatedPresenceWrapper({
  children,
  visible,
  preset = "fade-in",
  presenceKey = "animated-content",
}: AnimatedPresenceWrapperProps) {
  const variants = PRESET_VARIANTS[preset] ?? PRESET_VARIANTS["fade-in"]!;
  return (
    <AnimatePresence mode="wait">
      {visible && (
        <motion.div
          key={presenceKey}
          initial={variants.initial}
          animate={variants.animate}
          exit={variants.exit}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── PageTransition — 页面级过渡动画 ──────────────────────────

export interface PageTransitionProps {
  children: React.ReactNode;
  /** 过渡类型 */
  type?: "fade" | "slide" | "scale";
  className?: string;
}

export function PageTransition({ children, type = "fade", className }: PageTransitionProps) {
  const variants: Record<string, { initial: TargetAndTransition; animate: TargetAndTransition; exit: TargetAndTransition }> = {
    fade: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    },
    slide: {
      initial: { opacity: 0, x: 20 },
      animate: { opacity: 1, x: 0 },
      exit: { opacity: 0, x: -20 },
    },
    scale: {
      initial: { opacity: 0, scale: 0.95 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: 0.98 },
    },
  };

  const v = variants[type] ?? variants.fade!;

  return (
    <motion.div
      initial={v.initial}
      animate={v.animate}
      exit={v.exit}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export default AnimatedBlock;
