/**
 * @file pendingChunks.ts — 早到 chunk 的暂存区
 *
 * 📚 学习要点: 为什么会有「早到」的 chunk？
 * handleFileMeta 是异步的 —— 它要 await crypto.subtle.decrypt 解密元数据之后，
 * 才把传输登记进 store。这个 await 会让出事件循环，而发送方在 META 之后紧接着
 * 就开始发 chunk。落在这个窗口里的 chunk 查不到对应的传输。
 *
 * 过去这些 chunk 被静默丢弃，接收方只会在最后看到「文件不完整：已收到 N/M 个
 * 分片」，且没有任何日志 —— 一个和发送方速度相关、时有时无的故障。
 *
 * 本模块把它们暂存起来，等 metadata 登记完成后由 receiver 回放。
 *
 * 📚 学习要点: 为什么必须设上限
 * transferId 来自网络。恶意发送方可以为无数个并不存在的 transferId 持续发送
 * chunk，如果无限暂存，等于把本机内存的分配权交给对方。因此同时限制
 * 「暂存多少个传输」「每个传输暂存多少 chunk」，并用 TTL 清理那些永远等不到
 * metadata 的条目（传输被并发限制拒绝、已超时、或根本不存在）。
 *
 * 本模块刻意不 import 任何 store，保持可独立测试。
 *
 * @module file-transfer/pendingChunks
 * @see receiver.ts — 调用方（暂存与回放）
 */
import type { RelayFileChunkData } from '../network/protocol';

/** 最多同时为多少个未知传输暂存 chunk。 */
export const MAX_PENDING_TRANSFERS = 8;

/** 单个传输最多暂存多少个 chunk。竞态窗口很短，正常只会有个位数。 */
export const MAX_PENDING_CHUNKS_PER_TRANSFER = 32;

/** 暂存条目的存活时间；超过即认为 metadata 不会再来了。 */
export const PENDING_CHUNK_TTL_MS = 10_000;

interface PendingChunkEntry {
  chunks: RelayFileChunkData[];
  firstSeenAt: number;
}

const pending = new Map<string, PendingChunkEntry>();

/** 清理超过 TTL 仍未等到 metadata 的暂存条目。 */
function evictStale(now: number): void {
  for (const [id, entry] of pending) {
    if (now - entry.firstSeenAt > PENDING_CHUNK_TTL_MS) {
      pending.delete(id);
    }
  }
}

/**
 * 暂存一个在 metadata 之前到达的 chunk。
 *
 * @returns 是否被接受（false 表示触达上限而丢弃）
 */
export function bufferEarlyChunk(
  data: RelayFileChunkData,
  now: number = Date.now()
): boolean {
  evictStale(now);

  let entry = pending.get(data.transferId);
  if (!entry) {
    if (pending.size >= MAX_PENDING_TRANSFERS) return false;
    entry = { chunks: [], firstSeenAt: now };
    pending.set(data.transferId, entry);
  }
  if (entry.chunks.length >= MAX_PENDING_CHUNKS_PER_TRANSFER) return false;

  entry.chunks.push(data);
  return true;
}

/**
 * 取出并移除某个传输暂存的 chunk（按到达顺序）。
 *
 * 取出即移除，确保回放时 chunk 不会再次落入暂存分支。
 */
export function takeEarlyChunks(transferId: string): RelayFileChunkData[] {
  const entry = pending.get(transferId);
  if (!entry) return [];
  pending.delete(transferId);
  return entry.chunks;
}

/** 当前暂存的传输个数。供测试和诊断使用。 */
export function pendingTransferCount(): number {
  return pending.size;
}

/** 清空暂存区。仅供测试使用。 */
export function resetPendingChunks(): void {
  pending.clear();
}
