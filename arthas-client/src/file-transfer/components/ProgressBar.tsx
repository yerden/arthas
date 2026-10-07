/**
 * 文件传输进度条组件。
 *
 * 本组件负责在文件传输过程中向用户展示实时进度信息，包括：
 * - 可视化进度条（百分比填充）
 * - 传输速度（KB/s 或 MB/s）
 * - 预计剩余时间（秒或分钟）
 * - 每个 chunk 到达时的脉冲微动画反馈
 *
 * 📚 学习要点: 无障碍进度条设计
 * WAI-ARIA 规范要求进度条组件必须包含以下属性：
 * - `role="progressbar"`: 告知屏幕阅读器这是一个进度指示器
 * - `aria-valuenow`: 当前进度值（动态更新）
 * - `aria-valuemin` / `aria-valuemax`: 进度范围（0-100）
 * - `aria-label`: 描述性标签（屏幕阅读器朗读）
 * 这确保了视障用户也能获取传输进度信息。
 *
 * 📚 学习要点: prefers-reduced-motion 媒体查询
 * 部分用户（如前庭功能障碍患者）对动画敏感，可能导致头晕或恶心。
 * 操作系统提供了"减少动画"设置，浏览器通过 `prefers-reduced-motion` 媒体查询暴露。
 * 我们使用 Tailwind 的 `motion-reduce:` 前缀在 CSS 层面禁用动画，
 * 同时在 JS 层面通过 `window.matchMedia` 检测，避免不必要的动画类切换。
 * 这是 WCAG 2.1 Level AAA 的 2.3.3 准则（Animation from Interactions）的实现。
 *
 * @module file-transfer/components/ProgressBar
 * @see design.md — UI 组件设计
 * @see requirements.md — Requirements 7.1, 7.2, 7.4, 7.5, NFR-11, NFR-12, NFR-13
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * ProgressBar 组件的 Props 接口。
 *
 * 📚 学习要点: Props 设计原则
 * - `progress` 使用 0-100 的整数范围（而非 0-1 浮点），与 ARIA 规范一致
 * - `speed` 以 KB/s 为单位传入，组件内部负责格式化显示（单一职责）
 * - `eta` 以秒为单位，Infinity 表示无法估算（如速度为 0 时）
 * 这种设计让父组件只需传递原始数据，格式化逻辑封装在组件内部。
 */
export interface ProgressBarProps {
  /** 传输进度百分比，范围 [0, 100] */
  progress: number;
  /** 传输速度，单位 KB/s */
  speed: number;
  /** 预计剩余时间，单位秒；Infinity 表示无法估算 */
  eta: number;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 格式化传输速度为人类可读的字符串。
 *
 * 📚 学习要点: 单位自动切换
 * 当速度超过 1024 KB/s 时自动切换为 MB/s 显示，
 * 保留一位小数以平衡精度和可读性。
 * 使用 1024（而非 1000）作为换算基数，与文件系统惯例一致。
 *
 * @param speedKBps - 速度值，单位 KB/s
 * @returns 格式化后的速度字符串，如 "256.0 KB/s" 或 "1.5 MB/s"
 */
function formatSpeed(speedKBps: number): string {
  if (speedKBps >= 1024) {
    return `${(speedKBps / 1024).toFixed(1)} MB/s`;
  }
  return `${speedKBps.toFixed(1)} KB/s`;
}

/**
 * 格式化预计剩余时间为人类可读的字符串。
 *
 * 📚 学习要点: 边界情况处理
 * - Infinity: 速度为 0 时无法估算剩余时间，显示"计算中..."
 * - ≥ 60 秒: 转换为"Xm Ys"格式，更直观
 * - < 60 秒: 直接显示"Xs"
 * - ≤ 0: 传输即将完成，显示"<1s"
 *
 * @param etaSeconds - 剩余时间，单位秒；Infinity 表示无法估算
 * @returns 格式化后的时间字符串
 */
function formatEta(etaSeconds: number): string {
  // 无法估算（速度为 0 或刚开始传输）
  if (!isFinite(etaSeconds) || etaSeconds < 0) {
    return 'Calculating...';
  }

  // 即将完成
  if (etaSeconds < 1) {
    return '<1s remaining';
  }

  const seconds = Math.ceil(etaSeconds);

  // 超过 60 秒，使用分+秒格式
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s remaining`;
  }

  return `${seconds}s remaining`;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 文件传输进度条组件。
 *
 * 显示传输进度百分比、速度和预计剩余时间。
 * 每次 progress 更新时触发一次脉冲微动画（chunk 到达反馈），
 * 尊重用户的 `prefers-reduced-motion` 系统设置。
 *
 * 📚 学习要点: 微动画的用户体验价值
 * 进度条的脉冲动画不仅是装饰——它提供了「chunk 到达」的即时视觉反馈。
 * 在网络波动时，用户可能看到进度条长时间不动（等待下一个 chunk），
 * 脉冲动画在 chunk 到达瞬间给出确认，减少"是否卡住了？"的焦虑感。
 * 但对于动画敏感的用户，通过 `prefers-reduced-motion` 完全禁用。
 *
 * @example
 * ```tsx
 * <ProgressBar progress={45} speed={128.5} eta={12} />
 * // 显示: [====45%====          ] 128.5 KB/s | 剩余 12s
 * ```
 */
export function ProgressBar({ progress, speed, eta }: ProgressBarProps) {
  // --------------------------------------------------------------------------
  // 脉冲动画状态管理
  // --------------------------------------------------------------------------

  /**
   * 📚 学习要点: 单次动画触发机制
   * CSS 动画默认在元素挂载时播放一次。要在每次 progress 更新时重新触发，
   * 需要「移除动画类 → 强制重排 → 重新添加动画类」的技巧。
   *
   * 但这种方式依赖 DOM 操作且不够 React 化。更优雅的方案：
   * 使用 React key 或状态切换来触发重新渲染，让动画类在每次更新时
   * 通过短暂移除再添加来重新播放。
   *
   * 我们使用 `pulseKey` 计数器：每次 progress 变化时递增，
   * 作为动画容器的 key，强制 React 卸载旧元素并挂载新元素，
   * 从而自然触发 CSS 动画的首次播放。
   */
  const [pulseKey, setPulseKey] = useState(0);
  const prevProgressRef = useRef(progress);

  /**
   * 检测用户是否偏好减少动画。
   *
   * 📚 学习要点: matchMedia 的响应式监听
   * `window.matchMedia` 返回一个 MediaQueryList 对象，
   * 可以通过 `addEventListener('change', ...)` 监听系统设置变化。
   * 这意味着用户在传输过程中切换"减少动画"设置时，组件会立即响应。
   */
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  // 监听 prefers-reduced-motion 变化
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // 当 progress 变化时触发脉冲动画（仅在进度实际增加时）
  const triggerPulse = useCallback(() => {
    if (!prefersReducedMotion) {
      setPulseKey((k) => k + 1);
    }
  }, [prefersReducedMotion]);

  useEffect(() => {
    // 仅在 progress 实际增加时触发脉冲（避免初始渲染和回退时触发）
    if (progress > prevProgressRef.current) {
      triggerPulse();
    }
    prevProgressRef.current = progress;
  }, [progress, triggerPulse]);

  // --------------------------------------------------------------------------
  // 渲染
  // --------------------------------------------------------------------------

  // 将 progress 限制在合法范围内（防御性编程）
  const clampedProgress = Math.max(0, Math.min(100, progress));

  return (
    <div className="w-full space-y-1">
      {/* 进度条容器 */}
      <div
        role="progressbar"
        aria-valuenow={clampedProgress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`File transfer progress ${clampedProgress}%`}
        className="relative w-full h-2 bg-gray-700 rounded-full overflow-hidden"
      >
        {/*
          📚 学习要点: 进度条填充的实现方式
          使用 inline style 的 `width` 属性控制填充宽度，
          配合 Tailwind 的 `transition-all duration-300` 实现平滑过渡。
          
          为什么不用 Tailwind 的 w-[XX%] 类？
          - Tailwind 的 JIT 模式需要在编译时确定类名
          - 动态百分比值（如 w-[45%]）虽然 JIT 支持，但每个值都生成新类
          - inline style 更适合连续变化的数值，不会膨胀 CSS 文件
        */}
        <div
          key={pulseKey}
          className={`absolute inset-y-0 left-0 bg-blue-500 rounded-full
            transition-all duration-300 ease-out
            ${!prefersReducedMotion ? 'animate-pulse-once' : ''}
            motion-reduce:animate-none motion-reduce:transition-none`}
          style={{ width: `${clampedProgress}%` }}
        />
      </div>

      {/* 速度和剩余时间信息 */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span className="tabular-nums">
          {formatSpeed(speed)}
        </span>
        <span className="tabular-nums">
          {formatEta(eta)}
        </span>
      </div>
    </div>
  );
}
