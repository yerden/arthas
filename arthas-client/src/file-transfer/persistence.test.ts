/**
 * @file persistence.test.ts — 文件传输状态持久化单元测试
 *
 * 测试覆盖：
 * - persistTransferState(): 防抖写入 sessionStorage，只持久化非终态传输
 * - restoreTransferState(): 从 sessionStorage 恢复传输状态，标记为 'failed'
 * - 终态传输（complete/failed/cancelled）不应被持久化
 * - 恢复后 sessionStorage 被清除
 * - chunks 缓冲区不被持久化（只保存元数据）
 *
 * @module file-transfer/persistence.test
 * @see requirements.md — Requirements 10.1-10.4, 5.11, 11.6
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TransferState } from './types';

// ============================================================================
// Mock 设置
// ============================================================================

/**
 * 📚 学习要点: vi.mock 工厂函数的变量提升问题
 * vi.mock 会被 Vitest 提升到文件顶部执行，因此工厂函数内部
 * 不能引用文件中后续定义的变量（会触发 TDZ 错误）。
 * 解决方案：使用 vi.hoisted() 在 mock 之前声明共享状态。
 */
const { mockTransfersMapRef, mockSetState } = vi.hoisted(() => {
  return {
    mockTransfersMapRef: { current: new Map<string, any>() },
    mockSetState: { fn: null as any },
  };
});

// 在 hoisted 之后初始化 mockSetState.fn
mockSetState.fn = vi.fn();

// Mock fileTransferStore
vi.mock('./fileTransferStore', () => {
  const useFileTransferStore: any = (selector: (state: any) => any) => {
    const state = {
      transfers: mockTransfersMapRef.current,
      sendQueue: [],
      activeSendId: null,
      activeReceiveCount: 0,
    };
    return selector(state);
  };

  useFileTransferStore.getState = () => ({
    transfers: mockTransfersMapRef.current,
    sendQueue: [],
    activeSendId: null,
    activeReceiveCount: 0,
  });

  useFileTransferStore.setState = (...args: any[]) => mockSetState.fn(...args);

  useFileTransferStore.subscribe = () => () => {};

  return { useFileTransferStore };
});

// 导入被测模块（必须在 mock 之后）
import { persistTransferState, restoreTransferState, initPersistenceSubscription } from './persistence';

// ============================================================================
// 辅助函数
// ============================================================================

/** sessionStorage 存储键名（与 persistence.ts 中的常量一致） */
const STORAGE_KEY = 'arthas_file_transfers';

/**
 * 创建 mock TransferState，方便测试中快速构造不同状态的传输。
 */
function createMockTransfer(overrides: Partial<TransferState> = {}): TransferState {
  return {
    transferId: 'test-transfer-001',
    direction: 'receive',
    status: 'receiving',
    fileName: 'document.pdf',
    fileSize: 102400,
    mimeType: 'application/pdf',
    totalChunks: 2,
    receivedChunks: 1,
    lastReceivedIndex: 0,
    chunks: [new Uint8Array([1, 2, 3]), null],
    startTime: Date.now(),
    lastChunkTime: Date.now(),
    senderId: 'sender-001',
    senderName: 'Alice',
    ackCount: 0,
    totalReceivers: 0,
    chatMessageId: 'msg-001',
    ...overrides,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe('persistence.ts — 文件传输状态持久化', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockTransfersMapRef.current = new Map();
    mockSetState.fn.mockClear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // persistTransferState() 测试
  // ==========================================================================

  describe('persistTransferState() — 防抖持久化', () => {
    // 测试：防抖 500ms 后写入 sessionStorage
    it('在 500ms 防抖延迟后将活跃传输元数据写入 sessionStorage', () => {
      // 设置一个 receiving 状态的传输
      const transfer = createMockTransfer({ status: 'receiving' });
      mockTransfersMapRef.current.set('test-transfer-001', transfer);

      // 调用 persistTransferState（触发防抖）
      persistTransferState();

      // 防抖期间 sessionStorage 应该还是空的
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();

      // 快进 500ms（防抖延迟）
      vi.advanceTimersByTime(500);

      // 现在 sessionStorage 应该有数据了
      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].transferId).toBe('test-transfer-001');
      expect(parsed[0].fileName).toBe('document.pdf');
      expect(parsed[0].fileSize).toBe(102400);
      expect(parsed[0].status).toBe('receiving');
      expect(parsed[0].direction).toBe('receive');
      expect(parsed[0].mimeType).toBe('application/pdf');
    });

    // 测试：只持久化非终态传输（pending, sending, receiving）
    it('只持久化非终态传输，忽略 complete/failed/cancelled', () => {
      mockTransfersMapRef.current.set('t-pending', createMockTransfer({
        transferId: 't-pending',
        status: 'pending',
        direction: 'send',
      }));
      mockTransfersMapRef.current.set('t-sending', createMockTransfer({
        transferId: 't-sending',
        status: 'sending',
        direction: 'send',
      }));
      mockTransfersMapRef.current.set('t-receiving', createMockTransfer({
        transferId: 't-receiving',
        status: 'receiving',
        direction: 'receive',
      }));
      mockTransfersMapRef.current.set('t-complete', createMockTransfer({
        transferId: 't-complete',
        status: 'complete',
      }));
      mockTransfersMapRef.current.set('t-failed', createMockTransfer({
        transferId: 't-failed',
        status: 'failed',
      }));
      mockTransfersMapRef.current.set('t-cancelled', createMockTransfer({
        transferId: 't-cancelled',
        status: 'cancelled',
      }));

      persistTransferState();
      vi.advanceTimersByTime(500);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      // 只有 pending, sending, receiving 三个应该被持久化
      expect(parsed).toHaveLength(3);

      const ids = parsed.map((t: any) => t.transferId);
      expect(ids).toContain('t-pending');
      expect(ids).toContain('t-sending');
      expect(ids).toContain('t-receiving');
      // 终态传输不应出现
      expect(ids).not.toContain('t-complete');
      expect(ids).not.toContain('t-failed');
      expect(ids).not.toContain('t-cancelled');
    });

    // 测试：chunks 缓冲区不被持久化（只保存元数据）
    it('不持久化 chunks 缓冲区数据，只保存元数据字段', () => {
      const transfer = createMockTransfer({
        chunks: [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8])],
        blobUrl: 'blob:http://localhost/abc123',
        thumbnail: 'data:image/jpeg;base64,/9j/4AAQ...',
      });
      mockTransfersMapRef.current.set('test-transfer-001', transfer);

      persistTransferState();
      vi.advanceTimersByTime(500);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(stored!);

      // 验证只有元数据字段被持久化
      const persisted = parsed[0];
      expect(persisted).toHaveProperty('transferId');
      expect(persisted).toHaveProperty('fileName');
      expect(persisted).toHaveProperty('fileSize');
      expect(persisted).toHaveProperty('status');
      expect(persisted).toHaveProperty('direction');
      expect(persisted).toHaveProperty('mimeType');

      // chunks、blobUrl、thumbnail 等运行时数据不应被持久化
      expect(persisted).not.toHaveProperty('chunks');
      expect(persisted).not.toHaveProperty('blobUrl');
      expect(persisted).not.toHaveProperty('thumbnail');
      expect(persisted).not.toHaveProperty('receivedChunks');
      expect(persisted).not.toHaveProperty('startTime');
      expect(persisted).not.toHaveProperty('senderId');
    });

    // 测试：没有活跃传输时清除 sessionStorage 条目
    it('没有活跃传输时删除 sessionStorage 条目', () => {
      // 先写入一些数据
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([{ transferId: 'old' }]));

      // 设置只有终态传输
      mockTransfersMapRef.current.set('t-complete', createMockTransfer({
        transferId: 't-complete',
        status: 'complete',
      }));

      persistTransferState();
      vi.advanceTimersByTime(500);

      // sessionStorage 应该被清除
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    // 测试：防抖合并多次调用
    it('500ms 内多次调用只触发一次写入（防抖合并）', () => {
      const transfer = createMockTransfer({ status: 'sending' });
      mockTransfersMapRef.current.set('test-transfer-001', transfer);

      // 连续调用 3 次
      persistTransferState();
      vi.advanceTimersByTime(200);
      persistTransferState();
      vi.advanceTimersByTime(200);
      persistTransferState();

      // 此时还没到最后一次调用的 500ms
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();

      // 再过 500ms（从最后一次调用算起）
      vi.advanceTimersByTime(500);

      // 只写入了一次
      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // restoreTransferState() 测试
  // ==========================================================================

  describe('restoreTransferState() — 恢复传输状态', () => {
    // 测试：从 sessionStorage 恢复传输并标记为 'failed'
    it('恢复的传输被标记为 failed 并附带正确的错误信息', () => {
      const persistedData = [
        {
          transferId: 'restore-001',
          fileName: 'photo.png',
          fileSize: 204800,
          status: 'receiving',
          direction: 'receive',
          mimeType: 'image/png',
        },
        {
          transferId: 'restore-002',
          fileName: 'report.pdf',
          fileSize: 512000,
          status: 'sending',
          direction: 'send',
          mimeType: 'application/pdf',
        },
      ];
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData));

      const restored = restoreTransferState();

      // 应该恢复 2 个传输
      expect(restored).toHaveLength(2);

      // 验证第一个恢复的传输
      expect(restored[0].transferId).toBe('restore-001');
      expect(restored[0].status).toBe('failed');
      expect(restored[0].error).toBe('Page reloaded, transfer interrupted');
      expect(restored[0].fileName).toBe('photo.png');
      expect(restored[0].fileSize).toBe(204800);
      expect(restored[0].direction).toBe('receive');
      expect(restored[0].mimeType).toBe('image/png');
      expect(restored[0].chunks).toEqual([]);

      // 验证第二个恢复的传输
      expect(restored[1].transferId).toBe('restore-002');
      expect(restored[1].status).toBe('failed');
      expect(restored[1].error).toBe('Page reloaded, transfer interrupted');
      expect(restored[1].direction).toBe('send');
    });

    // 测试：恢复后 sessionStorage 被清除
    it('恢复完成后清除 sessionStorage 中的持久化数据', () => {
      const persistedData = [
        {
          transferId: 'restore-001',
          fileName: 'test.txt',
          fileSize: 1024,
          status: 'pending',
          direction: 'send',
          mimeType: 'text/plain',
        },
      ];
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData));

      restoreTransferState();

      // sessionStorage 应该被清除
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    // 测试：恢复后将传输写入 store
    it('恢复的传输通过 setState 写入 fileTransferStore', () => {
      const persistedData = [
        {
          transferId: 'restore-001',
          fileName: 'data.csv',
          fileSize: 8192,
          status: 'receiving',
          direction: 'receive',
          mimeType: 'text/csv',
        },
      ];
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData));

      restoreTransferState();

      // setState 应该被调用以将恢复的传输写入 store
      expect(mockSetState.fn).toHaveBeenCalled();
    });

    // 测试：sessionStorage 为空时返回空数组
    it('sessionStorage 无数据时返回空数组', () => {
      const restored = restoreTransferState();
      expect(restored).toEqual([]);
      expect(mockSetState.fn).not.toHaveBeenCalled();
    });

    // 测试：sessionStorage 数据损坏时安全处理
    it('sessionStorage 数据损坏（非法 JSON）时返回空数组并清除', () => {
      sessionStorage.setItem(STORAGE_KEY, 'not-valid-json{{{');

      const restored = restoreTransferState();

      expect(restored).toEqual([]);
      // 损坏的数据应该被清除
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    // 测试：sessionStorage 数据不是数组时安全处理
    it('sessionStorage 数据不是数组时返回空数组并清除', () => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));

      const restored = restoreTransferState();

      expect(restored).toEqual([]);
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    // 测试：跳过无效的持久化条目
    it('跳过缺少必要字段的无效条目', () => {
      const persistedData = [
        // 有效条目
        {
          transferId: 'valid-001',
          fileName: 'good.txt',
          fileSize: 1024,
          status: 'receiving',
          direction: 'receive',
          mimeType: 'text/plain',
        },
        // 无效条目：缺少 transferId
        {
          fileName: 'bad.txt',
          fileSize: 1024,
          status: 'receiving',
          direction: 'receive',
          mimeType: 'text/plain',
        },
        // 无效条目：fileSize 为 0
        {
          transferId: 'invalid-002',
          fileName: 'zero.txt',
          fileSize: 0,
          status: 'sending',
          direction: 'send',
          mimeType: 'text/plain',
        },
        // 无效条目：direction 不合法
        {
          transferId: 'invalid-003',
          fileName: 'bad-dir.txt',
          fileSize: 512,
          status: 'pending',
          direction: 'unknown',
          mimeType: 'text/plain',
        },
      ];
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistedData));

      const restored = restoreTransferState();

      // 只有第一个有效条目被恢复
      expect(restored).toHaveLength(1);
      expect(restored[0].transferId).toBe('valid-001');
    });
  });

  // ==========================================================================
  // initPersistenceSubscription() 测试
  // ==========================================================================

  describe('initPersistenceSubscription() — 订阅初始化', () => {
    it('返回取消订阅函数', () => {
      const unsubscribe = initPersistenceSubscription();
      expect(typeof unsubscribe).toBe('function');
    });
  });
});
