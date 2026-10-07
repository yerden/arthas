/**
 * @file useAppHeight.ts — 跟随可视视口的应用高度
 *
 * 📚 学习要点: 布局视口 ≠ 可视视口
 * iOS Safari 弹出键盘时并不会改变布局视口的高度 —— 100vh 和 100dvh 都保持
 * 原样，只有「可视视口」(window.visualViewport) 变矮了。浏览器为了把输入框
 * 露出来，会把整个页面向上推。
 *
 * 等键盘收起时可视视口恢复，但页面可能停在被推上去的位置，而固定高度的应用
 * 外壳并没有重新布局。结果就是上半屏是界面、下半屏露出 body 的底色 ——
 * 看起来像「发完消息后下半个屏幕黑掉了」。
 *
 * 这里把可视视口高度写进 CSS 变量 --app-height，让外壳跟随它变化，
 * 并在变化后滚回顶部，抵消浏览器的推移。
 *
 * @module hooks/useAppHeight
 */
import { useEffect } from 'react';

/**
 * 把当前可视视口高度同步到 --app-height。
 * 在应用根组件调用一次即可；变量是全局的。
 */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;

    const apply = (): void => {
      // 📚 学习要点: 缩放也会改变 visualViewport.height，要换算回布局高度
      // visualViewport 描述的是「当前看得见的区域」，不是布局高度：放大到 2 倍
      // 时可见区域只剩一半，height 也随之减半，但布局并没有变矮。乘回 scale
      // 即可还原布局高度 —— 缩放时结果不变，键盘弹出时（scale 为 1）如实缩小。
      //
      // 这里刻意不采用「缩放时直接跳过更新」的写法：只要 scale 有一次不等于
      // 1，高度就会被永久卡在旧值上，表现正是「键盘收起了但界面没有恢复」。
      // 换算的做法没有这种失效状态。
      const scale = viewport?.scale ?? 1;

      // visualViewport 不可用时退回 innerHeight —— 它至少会随屏幕旋转更新。
      const height = viewport ? viewport.height * scale : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);

      // 键盘收起后浏览器可能把页面留在上推后的偏移上，固定高度的外壳不会
      // 自己回位。滚回顶部可以消除底部露出的空白。
      //
      // 📚 学习要点: 只在「这个页面本来就不该滚动」时纠正偏移
      // Home / Hub / Match 用的是 min-h-screen，它们是真的要靠文档滚动的
      // （见 312b34c 修复的移动端无法滚动问题）。而 iOS 在普通滚动时同样会
      // 触发 visualViewport 的 scroll 事件，无条件 scrollTo(0, 0) 会把用户的
      // 滚动位置不停拽回顶部 —— 表现就是「页面滚不动」。
      //
      // 判据：文档整体高度没有超过可视视口，说明没有可滚动的内容，此时任何
      // 非零的 scrollY 都是浏览器推移留下的残留，纠正它是安全的。
      // 缩放状态下的平移是用户的主动操作，不能纠正。
      const zoomed = Math.abs(scale - 1) > 0.01;
      const pageFitsViewport =
        document.documentElement.scrollHeight <= Math.ceil(height) + 1;
      if (!zoomed && pageFitsViewport && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    // 📚 学习要点: iOS 不保证在键盘收起后补发最后一次 resize
    // 少了那一次事件，--app-height 就会停在键盘压缩后的高度上，界面卡在
    // 上半屏。输入框失焦后延迟再同步一次作为兜底 —— 多跑一次没有副作用，
    // 漏掉一次则整个界面都不会恢复。
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const applyAfterSettle = (): void => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, 300);
    };

    apply();

    // scroll 也要监听：iOS 在键盘动画期间是通过滚动可视视口来推移页面的，
    // 只听 resize 会漏掉中间状态。
    viewport?.addEventListener('resize', apply);
    viewport?.addEventListener('scroll', apply);
    window.addEventListener('orientationchange', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('focusout', applyAfterSettle);

    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      viewport?.removeEventListener('resize', apply);
      viewport?.removeEventListener('scroll', apply);
      window.removeEventListener('orientationchange', apply);
      window.removeEventListener('resize', apply);
      window.removeEventListener('focusout', applyAfterSettle);
    };
  }, []);
}
