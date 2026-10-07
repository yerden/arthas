/**
 * @file pendingChunks.test.ts — 早到 chunk 暂存区的单元测试
 *
 * 这里守护两组性质：
 * 1. 功能性：早到的 chunk 必须能被完整、按序地取回 —— 丢掉任何一个，
 *    接收方最终就会报「文件不完整」。
 * 2. 安全性：transferId 来自网络，暂存必须有上限，否则对方可以用不存在的
 *    transferId 不断发 chunk 来耗尽本机内存。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  bufferEarlyChunk,
  takeEarlyChunks,
  pendingTransferCount,
  resetPendingChunks,
  MAX_PENDING_TRANSFERS,
  MAX_PENDING_CHUNKS_PER_TRANSFER,
  PENDING_CHUNK_TTL_MS,
} from '../pendingChunks';
import type { RelayFileChunkData } from '../../network/protocol';

function chunk(transferId: string, index: number): RelayFileChunkData {
  return {
    transferId,
    index,
    iv: new Uint8Array(12),
    data: new Uint8Array([index]),
  } as RelayFileChunkData;
}

describe('pendingChunks', () => {
  beforeEach(() => {
    resetPendingChunks();
  });

  it('returns buffered chunks in arrival order', () => {
    bufferEarlyChunk(chunk('t1', 0));
    bufferEarlyChunk(chunk('t1', 1));
    bufferEarlyChunk(chunk('t1', 2));

    expect(takeEarlyChunks('t1').map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('keeps transfers isolated from each other', () => {
    bufferEarlyChunk(chunk('t1', 0));
    bufferEarlyChunk(chunk('t2', 7));

    expect(takeEarlyChunks('t2').map((c) => c.index)).toEqual([7]);
    expect(takeEarlyChunks('t1').map((c) => c.index)).toEqual([0]);
  });

  // 取出即移除，否则回放时 chunk 会再次落入暂存分支，形成重复。
  it('removes the entry once taken', () => {
    bufferEarlyChunk(chunk('t1', 0));

    expect(takeEarlyChunks('t1')).toHaveLength(1);
    expect(takeEarlyChunks('t1')).toHaveLength(0);
    expect(pendingTransferCount()).toBe(0);
  });

  it('returns empty for an unknown transfer', () => {
    expect(takeEarlyChunks('never-seen')).toEqual([]);
  });

  it('caps the number of chunks held per transfer', () => {
    for (let i = 0; i < MAX_PENDING_CHUNKS_PER_TRANSFER + 10; i++) {
      bufferEarlyChunk(chunk('t1', i));
    }

    expect(takeEarlyChunks('t1')).toHaveLength(MAX_PENDING_CHUNKS_PER_TRANSFER);
  });

  it('reports rejection once a transfer is full', () => {
    for (let i = 0; i < MAX_PENDING_CHUNKS_PER_TRANSFER; i++) {
      expect(bufferEarlyChunk(chunk('t1', i))).toBe(true);
    }
    expect(bufferEarlyChunk(chunk('t1', 999))).toBe(false);
  });

  // 没有这个上限，对方可以用无穷多个伪造 transferId 占满内存。
  it('caps the number of distinct transfers held', () => {
    for (let i = 0; i < MAX_PENDING_TRANSFERS; i++) {
      expect(bufferEarlyChunk(chunk(`t${i}`, 0))).toBe(true);
    }
    expect(bufferEarlyChunk(chunk('one-too-many', 0))).toBe(false);
    expect(pendingTransferCount()).toBe(MAX_PENDING_TRANSFERS);
  });

  it('evicts entries whose metadata never arrived', () => {
    const t0 = 1_000_000;
    bufferEarlyChunk(chunk('stale', 0), t0);

    // 下一次写入时触发清理
    bufferEarlyChunk(chunk('fresh', 0), t0 + PENDING_CHUNK_TTL_MS + 1);

    expect(takeEarlyChunks('stale')).toEqual([]);
    expect(takeEarlyChunks('fresh')).toHaveLength(1);
  });

  it('frees capacity after stale entries expire', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_PENDING_TRANSFERS; i++) {
      bufferEarlyChunk(chunk(`t${i}`, 0), t0);
    }
    expect(bufferEarlyChunk(chunk('blocked', 0), t0)).toBe(false);

    // TTL 过后，被遗弃的条目让出空间
    expect(bufferEarlyChunk(chunk('later', 0), t0 + PENDING_CHUNK_TTL_MS + 1)).toBe(true);
  });
});
