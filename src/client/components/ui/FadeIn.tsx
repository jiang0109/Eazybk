/**
 * 进场动画包装组件。
 *
 * 这就是需求里说的"平滑的滚动动画"：
 * 元素滚动进入视口时淡入上移。用 framer-motion 的 whileInView 实现，
 * 它内部用的是 IntersectionObserver，比监听 scroll 事件性能好得多
 * （不会每一帧都触发回调）。
 *
 * 两个容易出错的点：
 *   1. once: true —— 只播一次。否则来回滚动会反复播放，很吵。
 *   2. viewport.margin —— 提前一点触发，等元素完全进入视口才开始淡入会显得迟滞。
 */

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

interface FadeInProps {
  children: ReactNode;
  /** 依次出现的延迟序号，让列表有"逐个浮现"的层次感 */
  index?: number;
  className?: string;
}

/**
 * 进场动画包装组件：元素滚入视口时向上滑入。
 *
 * ⚠️ 这里**只动 y，不动 opacity**，是踩过坑之后的有意选择。
 *
 * 原因：动画如果在某种渲染时序下没跑完（无头浏览器截图、快照测试、
 * 首屏首帧被采集、用户开了"减少动态效果"），`opacity: 0` 的初始状态
 * 会让内容**整块看不见** —— 看起来就是"页面白了/空了"，很难排查。
 * 而只位移的话，最差情况只是"内容位置偏下十几像素"，仍然完全可读。
 *
 * 通用原则：**内容的可见性不应该依赖动画是否执行成功。**
 * 动画是锦上添花，不能是显示内容的前提。
 */
export function FadeIn({ children, index = 0, className }: FadeInProps) {
  return (
    <motion.div
      className={className}
      initial={{ y: 14 }}
      whileInView={{ y: 0 }}
      viewport={{ once: true, margin: '0px 0px -32px 0px' }}
      transition={{
        duration: 0.32,
        // 用 easeOut，入场动画"先快后慢"最自然
        ease: [0.16, 1, 0.3, 1],
        // 最多延迟 240ms，避免长列表后面的元素等太久才出现
        delay: Math.min(index * 0.035, 0.24),
      }}
    >
      {children}
    </motion.div>
  );
}
