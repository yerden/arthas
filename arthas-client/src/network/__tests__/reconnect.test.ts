/**
 * @file reconnect.test.ts — 重连回调的触发语义
 *
 * 这个回调负责在重连后重新加入房间。两个方向都可能出错：
 * - 首次连接就触发 → 在还没 join 过的时候就发 JoinRoom
 * - 重连时不触发 → 对端永远认为我们已经离开（最初的 bug）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connect, disconnect, onReconnect } from '../websocket';

/** 最小 WebSocket 替身：能被构造，并由测试手动触发 onopen。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  binaryType = '';
  readyState = 1;
  close = vi.fn();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

function openLatest(): void {
  const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  latest.onopen?.();
}

describe('onReconnect', () => {
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    disconnect();
    onReconnect(null);
    (globalThis as Record<string, unknown>).WebSocket = original;
    vi.restoreAllMocks();
  });

  it('does not fire on the first connection', () => {
    const handler = vi.fn();
    onReconnect(handler);

    connect('ws://test/ws');
    openLatest();

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires on a subsequent connection', () => {
    const handler = vi.fn();
    onReconnect(handler);

    connect('ws://test/ws');
    openLatest();
    connect('ws://test/ws');
    openLatest();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // 主动断开后再连属于重新开始，不该当成重连去重新加入旧房间。
  it('treats a connection after an explicit disconnect as a first connection', () => {
    const handler = vi.fn();
    onReconnect(handler);

    connect('ws://test/ws');
    openLatest();
    disconnect();

    connect('ws://test/ws');
    openLatest();

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when no handler is registered', () => {
    onReconnect(null);
    connect('ws://test/ws');
    openLatest();

    expect(() => {
      connect('ws://test/ws');
      openLatest();
    }).not.toThrow();
  });
});
