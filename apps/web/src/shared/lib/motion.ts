import { type Variants } from 'framer-motion';

// 路由切换：淡入+上滑
export const fadeSlide: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
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
