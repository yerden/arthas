/**
 * @file useAppHeight.test.ts — 可视视口高度同步
 *
 * 这里主要守护一条曾经造成回归的性质：纠正滚动偏移只能发生在「本来就不该
 * 滚动」的页面上。iOS 普通滚动同样会触发 visualViewport 的 scroll 事件，
 * 无条件 scrollTo(0, 0) 会把用户的滚动位置不停拽回顶部。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAppHeight } from '../useAppHeight';

type Listener = () => void;

function fakeViewport(height: number, scale = 1) {
  const listeners: Record<string, Listener[]> = {};
  return {
    height,
    scale,
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    },
    emit: (type: string) => (listeners[type] ?? []).forEach((fn) => fn()),
    listenerCount: (type: string) => (listeners[type] ?? []).length,
  };
}

function setDocumentHeight(px: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => px,
  });
}

function setScrollY(px: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: px });
}

describe('useAppHeight', () => {
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
    setScrollY(0);
    setDocumentHeight(600);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).visualViewport;
    document.documentElement.style.removeProperty('--app-height');
    vi.restoreAllMocks();
  });

  it('publishes the visual viewport height as --app-height', () => {
    (window as unknown as Record<string, unknown>).visualViewport = fakeViewport(500);

    renderHook(() => useAppHeight());

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px');
  });

  it('updates when the viewport resizes', () => {
    const vp = fakeViewport(800);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    renderHook(() => useAppHeight());

    vp.height = 400; // keyboard opened
    vp.emit('resize');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('400px');
  });

  // 回归守护：可滚动的页面（Home / Hub 用 min-h-screen）绝不能被拽回顶部。
  it('never resets scroll on a page taller than the viewport', () => {
    const vp = fakeViewport(500);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    setDocumentHeight(2000); // 内容远高于视口
    setScrollY(300); // 用户已经滚下去了

    renderHook(() => useAppHeight());
    vp.emit('scroll');

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('resets a stale offset when the page fits the viewport', () => {
    const vp = fakeViewport(500);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    setDocumentHeight(500); // 固定高度外壳，没有可滚动内容
    setScrollY(120); // 键盘推移留下的残留

    renderHook(() => useAppHeight());

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('leaves scroll alone when already at the top', () => {
    (window as unknown as Record<string, unknown>).visualViewport = fakeViewport(500);
    setDocumentHeight(500);
    setScrollY(0);

    renderHook(() => useAppHeight());

    expect(scrollTo).not.toHaveBeenCalled();
  });

  // 回归守护：双指缩放会让 visualViewport.height 变小，但布局并没有变矮。
  // 跟着缩小外壳会把界面压成半屏，下面露出一大片空白。
  it('ignores height changes while the user is pinch-zoomed', () => {
    const vp = fakeViewport(800);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    renderHook(() => useAppHeight());
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');

    // 放大到 2 倍：可见区域减半，但布局高度不变
    vp.scale = 2;
    vp.height = 400;
    vp.emit('resize');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
  });

  it('resumes tracking once zoom returns to 1:1', () => {
    const vp = fakeViewport(800);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    renderHook(() => useAppHeight());

    vp.scale = 2;
    vp.height = 400;
    vp.emit('resize');

    vp.scale = 1;
    vp.height = 500; // 回到 1:1，键盘弹出
    vp.emit('resize');

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px');
  });

  it('does not reset scroll while zoomed', () => {
    const vp = fakeViewport(400, 2);
    (window as unknown as Record<string, unknown>).visualViewport = vp;
    setDocumentHeight(400);
    setScrollY(150); // 缩放后平移页面是正常操作，不能被拽回去

    renderHook(() => useAppHeight());

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('falls back to innerHeight without visualViewport', () => {
    delete (window as unknown as Record<string, unknown>).visualViewport;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 731 });

    renderHook(() => useAppHeight());

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('731px');
  });

  it('removes its listeners on unmount', () => {
    const vp = fakeViewport(500);
    (window as unknown as Record<string, unknown>).visualViewport = vp;

    const { unmount } = renderHook(() => useAppHeight());
    expect(vp.listenerCount('resize')).toBe(1);

    unmount();
    expect(vp.listenerCount('resize')).toBe(0);
    expect(vp.listenerCount('scroll')).toBe(0);
  });
});
