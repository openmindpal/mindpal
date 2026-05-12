import { type Variants } from 'framer-motion';

// 路由切换：淡入+上滑
export const fadeSlide: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
};

// 模态/弹层：缩放+淡入
export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.15 } },
};

// 叠加层淡入
export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// 列表 stagger 容器
export const staggerContainer: Variants = {
  animate: { transition: { staggerChildren: 0.03 } },
};

// 列表项
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

// 侧滑（Sheet）
export const slideRight: Variants = {
  initial: { x: '100%' },
  animate: { x: 0, transition: { duration: 0.3, ease: [0.32, 0.72, 0, 1] } },
  exit: { x: '100%', transition: { duration: 0.2 } },
};
