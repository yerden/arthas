/**
 * @file persistence.ts — 文件传输状态持久化（sessionStorage）
 *
 * 本文件负责将活跃的文件传输元数据持久化到 sessionStorage，
 * 以便在页面刷新后能够恢复传输状态（标记为失败）并通知用户。
 *
 * 📚 学习要点: 为什么需要持久化传输状态？
 * 文件传输是一个持续数秒到数十秒的过程。如果用户在传输过程中刷新页面：
 * - 内存中的 Zustand store 状态会丢失
 * - WebSocket 连接会断开
 * - 传输无法继续（不支持断点续传）
 * 通过持久化元数据到 sessionStorage，页面重新加载后可以：
 * 1. 恢复传输记录（标记为 'failed'）
 * 2. 向用户显示"页面刷新，传输已中断"的明确反馈
 * 3. 避免用户困惑（"我的文件传输去哪了？"）
 *
 * 📚 学习要点: 为什么选择 sessionStorage 而非 localStorage？
 * - sessionStorage 的生命周期与浏览器标签页绑定：
 *   - 刷新页面：数据保留（正是我们需要的）
 *   - 关闭标签页：数据自动清除（无需手动清理）
 * - localStorage 会跨标签页共享，可能导致多标签页场景下的状态冲突
 * - 文件传输状态是临时的、会话级别的，sessionStorage 语义完美匹配
 *
 * 📚 学习要点: 为什么不持久化 chunk 缓冲区？
 * 1. 内存/存储限制：sessionStorage 通常限制 5-10MB，一个 5MB 文件的 chunk 缓冲区
 *    序列化后（base64）会膨胀到 ~6.7MB，可能超出限制
 * 2. 无断点续传支持：即使恢复了 chunk 缓冲区，WebSocket 连接已断开，
 *    无法继续接收剩余 chunk（服务器不缓存、不重发）
 * 3. 性能开销：每次状态变化都序列化大量二进制数据到 sessionStorage 会阻塞主线程
 * 4. 设计简洁性：只持久化元数据（几百字节），恢复时直接标记失败，逻辑清晰
 *
 * 📚 学习要点: 防抖（Debounce）策略
 * 文件传输过程中，状态变化非常频繁（每收到一个 chunk 就更新一次进度）。
 * 如果每次状态变化都写入 sessionStorage，会导致：
 * - 大量的序列化开销（JSON.stringify）
 * - 频繁的同步 I/O 操作（sessionStorage 是同步 API）
 * - 可能影响主线程性能（尤其在低端设备上）
 *
 * 使用 500ms 防抖：
 * - 在 500ms 内的多次状态变化只触发一次写入
 * - 最坏情况：页面在最后一次写入后 499ms 内刷新，丢失最近的状态变化
 * - 但这不影响功能正确性：恢复时统一标记为 'failed'，不依赖精确的进度值
 * - 500ms 是一个平衡点：足够频繁以捕获状态变化，又不会过于频繁影响性能
 *
 * @module file-transfer/persistence
 * @see design.md — 传输状态持久化设计
 * @see requirements.md — Requirements 5.11, 11.6
 */

import { useFileTransferStore } from './fileTransferStore';
import type { TransferState, TransferStatus, TransferDirection } from './types';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * sessionStorage 存储键名。
 *
 * 📚 学习要点: 键名命名约定
 * 使用 `arthas_` 前缀避免与其他应用的 sessionStorage 键冲突。
 * 虽然 sessionStorage 是按域名隔离的，但同一域名下可能有多个应用模块，
 * 前缀可以明确标识数据的归属，便于调试和清理。
 */
const STORAGE_KEY = 'arthas_file_transfers';

/**
 * 防抖延迟时间：500ms。
 *
 * 📚 学习要点: 为什么选择 500ms？
 * - 文件传输每 ~10ms 发送一个 chunk，接收方每 ~10ms 更新一次进度
 * - 如果不防抖，每秒会写入 sessionStorage ~100 次
 * - 500ms 防抖将写入频率降低到最多 2 次/秒
 * - 即使在最坏情况下（刷新时丢失最近 500ms 的状态），
 *   恢复逻辑也只是将传输标记为 'failed'，不依赖精确进度
 */
const DEBOUNCE_MS = 500;

// ============================================================================
// 持久化数据结构
// ============================================================================

/**
 * 持久化到 sessionStorage 的传输元数据（精简版）。
 *
 * 📚 学习要点: 数据最小化原则
 * 只持久化恢复所需的最少信息：
 * - transferId: 唯一标识，用于恢复后在 store 中创建条目
 * - fileName, fileSize: 用于 UI 显示（用户需要知道哪个文件传输中断了）
 * - status: 用于判断是否需要恢复（只持久化非终态的传输）
 * - direction: 用于恢复后正确设置传输方向
 *
 * 不持久化的字段：
 * - chunks: 二进制数据太大，且无法恢复传输
 * - blobUrl: Blob URL 在页面刷新后失效
 * - startTime/lastChunkTime: 恢复后不需要计算速度
 * - senderId/senderName: 恢复后只显示错误信息，不需要发送方信息
 */
interface PersistedTransferMeta {
  /** 唯一传输标识符 */
  transferId: string;
  /** 文件名（用于 UI 显示） */
  fileName: string;
  /** 文件大小（字节，用于 UI 显示） */
  fileSize: number;
  /** 持久化时的传输状态 */
  status: TransferStatus;
  /** 传输方向 */
  direction: TransferDirection;
  /** MIME 类型（用于文件图标显示） */
  mimeType: string;
}

// ============================================================================
// 模块级状态（防抖定时器）
// ============================================================================

/**
 * 防抖定时器句柄。
 *
 * 📚 学习要点: 模块级变量 vs 闭包
 * 使用模块级变量存储定时器句柄，确保：
 * 1. 同一时间只有一个待执行的写入操作
 * 2. 新的状态变化可以取消之前的待执行写入（clearTimeout）
 * 3. 模块卸载时可以清理定时器（防止内存泄漏）
 *
 * 使用 ReturnType<typeof setTimeout> 类型而非 number，
 * 因为在 Node.js 环境（测试）中 setTimeout 返回 NodeJS.Timeout 对象，
 * 而在浏览器中返回 number。这样可以兼容两种环境。
 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 持久化当前活跃传输状态到 sessionStorage（防抖 500ms）。
 *
 * 📚 学习要点: 防抖实现模式
 * 经典的防抖（debounce）模式：
 * 1. 每次调用时，清除之前的定时器（如果存在）
 * 2. 设置新的定时器，延迟 500ms 后执行实际写入
 * 3. 如果在 500ms 内再次调用，步骤 1 会取消之前的定时器
 * 4. 只有最后一次调用后的 500ms 内没有新调用，才会真正执行写入
 *
 * 这确保了高频状态变化（如每 10ms 一次的 chunk 进度更新）
 * 不会导致 sessionStorage 被频繁写入。
 *
 * @example
 * ```typescript
 * // 在 store 订阅中调用
 * useFileTransferStore.subscribe(() => {
 *   persistTransferState();
 * });
 * ```
 *
 * @see requirements.md — Requirement 5.11
 */
export function persistTransferState(): void {
  // 清除之前的待执行写入（防抖核心逻辑）
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }

  // 设置新的延迟写入
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeToSessionStorage();
  }, DEBOUNCE_MS);
}

/**
 * 实际执行 sessionStorage 写入的内部函数。
 *
 * 📚 学习要点: 只持久化非终态传输
 * 终态传输（complete, failed, cancelled）不需要持久化：
 * - complete: 文件已下载完成，刷新后无需恢复
 * - failed: 已经是失败状态，无需再次标记
 * - cancelled: 用户已主动取消，无需恢复
 *
 * 只有 pending、sending、receiving 状态的传输需要持久化，
 * 因为这些传输在刷新后无法继续，需要通知用户。
 */
function writeToSessionStorage(): void {
  const { transfers } = useFileTransferStore.getState();

  // 筛选非终态的活跃传输
  const activeTransfers: PersistedTransferMeta[] = [];

  for (const [, transfer] of transfers) {
    if (isActiveStatus(transfer.status)) {
      activeTransfers.push({
        transferId: transfer.transferId,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        status: transfer.status,
        direction: transfer.direction,
        mimeType: transfer.mimeType,
      });
    }
  }

  // 📚 学习要点: 空数组时清除存储条目
  // 如果没有活跃传输，删除 sessionStorage 条目而非存储空数组。
  // 这减少了不必要的存储占用，也使得 restoreTransferState() 的判断更简单。
  if (activeTransfers.length === 0) {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // sessionStorage 不可用时静默忽略（如隐私模式下某些浏览器）
      // 📚 学习要点: sessionStorage 可能不可用
      // 在以下情况下 sessionStorage 操作会抛出异常：
      // - 浏览器隐私模式（Safari 的某些版本）
      // - 存储配额已满
      // - 用户禁用了 Web Storage
      // 持久化是"尽力而为"的增强功能，失败不应影响核心传输逻辑。
    }
    return;
  }

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(activeTransfers));
  } catch {
    // 静默忽略写入失败（存储配额满、隐私模式等）
    console.warn('[FileTransfer] Cannot write to sessionStorage, skipping persistence');
  }
}

/**
 * 从 sessionStorage 恢复传输状态（页面加载时调用）。
 *
 * 📚 学习要点: 恢复策略 — 统一标记为 'failed'
 * 页面刷新后，所有之前活跃的传输都无法继续：
 * - WebSocket 连接已断开
 * - 内存中的 chunk 缓冲区已丢失
 * - 服务器不支持断点续传
 *
 * 因此恢复策略很简单：将所有持久化的传输恢复为 'failed' 状态，
 * 并附带明确的错误信息"页面刷新，传输已中断"。
 * 这让用户知道：
 * 1. 之前有传输在进行中
 * 2. 传输因为页面刷新而中断
 * 3. 需要重新发送文件（如果需要的话）
 *
 * @returns 恢复的传输状态数组（已标记为 failed），如果没有需要恢复的则返回空数组
 *
 * @example
 * ```typescript
 * // 在应用启动时调用
 * const restored = restoreTransferState();
 * if (restored.length > 0) {
 *   console.log(`恢复了 ${restored.length} 个中断的传输`);
 * }
 * ```
 *
 * @see requirements.md — Requirement 11.6
 */
export function restoreTransferState(): TransferState[] {
  let raw: string | null = null;

  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage 不可用，无法恢复
    return [];
  }

  // 没有持久化数据，无需恢复
  if (!raw) {
    return [];
  }

  // 📚 学习要点: 防御性解析
  // sessionStorage 中的数据可能被用户手动修改或损坏。
  // 使用 try-catch 包裹 JSON.parse，并验证解析结果的结构。
  // 如果数据无效，静默清除并返回空数组（不影响应用启动）。
  let persisted: PersistedTransferMeta[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      clearPersistedState();
      return [];
    }
    persisted = parsed;
  } catch {
    // JSON 解析失败，数据损坏
    clearPersistedState();
    return [];
  }

  // 验证并恢复每个传输
  const restoredTransfers: TransferState[] = [];

  for (const meta of persisted) {
    // 基本字段验证
    if (!isValidPersistedMeta(meta)) {
      continue; // 跳过无效条目
    }

    // 创建恢复后的 TransferState（标记为 failed）
    const restoredTransfer: TransferState = {
      transferId: meta.transferId,
      direction: meta.direction,
      status: 'failed' as TransferStatus,
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      mimeType: meta.mimeType,
      totalChunks: Math.ceil(meta.fileSize / 65536), // 根据文件大小重新计算
      receivedChunks: 0,
      lastReceivedIndex: -1,
      chunks: [],           // 不恢复 chunk 缓冲区
      error: 'Page reloaded, transfer interrupted',
      startTime: Date.now(),
      lastChunkTime: Date.now(),
      senderId: '',
      senderName: '',
      ackCount: 0,
      totalReceivers: 0,
      chatMessageId: '',
    };

    restoredTransfers.push(restoredTransfer);
  }

  // 将恢复的传输写入 store
  if (restoredTransfers.length > 0) {
    useFileTransferStore.setState((state) => {
      const newTransfers = new Map(state.transfers);
      for (const transfer of restoredTransfers) {
        newTransfers.set(transfer.transferId, transfer);
      }
      return { transfers: newTransfers };
    });
  }

  // 📚 学习要点: 恢复后立即清除 sessionStorage
  // 恢复完成后清除持久化数据，原因：
  // 1. 防止重复恢复：如果用户再次刷新，不应该再次恢复已经标记为 failed 的传输
  // 2. 数据卫生：已处理的数据不应继续占用存储空间
  // 3. 简化逻辑：下次 persistTransferState() 调用时从干净状态开始
  clearPersistedState();

  return restoredTransfers;
}

/**
 * 初始化持久化订阅：监听 store 状态变化，自动触发持久化。
 *
 * 📚 学习要点: Zustand subscribe 机制
 * Zustand 的 `subscribe` 方法允许在 store 状态变化时执行回调。
 * 与 React 组件中的 `useStore(selector)` 不同：
 * - subscribe 是命令式的，不依赖 React 渲染周期
 * - 适合在非组件代码中监听状态变化（如持久化、日志、分析）
 * - 返回一个 unsubscribe 函数，用于清理订阅
 *
 * 注意：subscribe 回调在每次 setState 调用后同步执行。
 * 因此回调中不应执行耗时操作（这里通过防抖将实际写入延迟到 500ms 后）。
 *
 * @returns 取消订阅的函数（用于清理）
 *
 * @example
 * ```typescript
 * // 在应用启动时初始化
 * const unsubscribe = initPersistenceSubscription();
 *
 * // 在应用卸载时清理（通常不需要，因为页面关闭时自动清理）
 * unsubscribe();
 * ```
 */
export function initPersistenceSubscription(): () => void {
  const unsubscribe = useFileTransferStore.subscribe(() => {
    persistTransferState();
  });

  return unsubscribe;
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 判断传输状态是否为"活跃"（非终态）。
 *
 * 📚 学习要点: 活跃状态 vs 终态
 * - 活跃状态（需要持久化）：pending, sending, receiving
 *   这些状态表示传输正在进行中，页面刷新会导致中断
 * - 终态（不需要持久化）：complete, failed, cancelled
 *   这些状态表示传输已结束，无需在刷新后恢复
 *
 * @param status - 传输状态
 * @returns 是否为活跃状态
 */
function isActiveStatus(status: TransferStatus): boolean {
  return status === 'pending' || status === 'sending' || status === 'receiving';
}

/**
 * 验证持久化元数据的基本结构是否有效。
 *
 * 📚 学习要点: 防御性编程 — 不信任外部数据
 * sessionStorage 中的数据可能被：
 * - 用户通过 DevTools 手动修改
 * - 浏览器扩展篡改
 * - 存储损坏（极少见但可能）
 *
 * 因此在恢复时必须验证每个字段的类型和合理性，
 * 而不是盲目信任 JSON.parse 的结果。
 *
 * @param meta - 待验证的持久化元数据
 * @returns 是否为有效的持久化元数据
 */
function isValidPersistedMeta(meta: unknown): meta is PersistedTransferMeta {
  if (typeof meta !== 'object' || meta === null) return false;

  const obj = meta as Record<string, unknown>;

  return (
    typeof obj.transferId === 'string' && obj.transferId.length > 0 &&
    typeof obj.fileName === 'string' &&
    typeof obj.fileSize === 'number' && obj.fileSize > 0 &&
    typeof obj.status === 'string' &&
    typeof obj.direction === 'string' &&
    (obj.direction === 'send' || obj.direction === 'receive') &&
    typeof obj.mimeType === 'string'
  );
}

/**
 * 清除 sessionStorage 中的持久化数据。
 *
 * @internal 仅在恢复完成后或数据损坏时调用
 */
function clearPersistedState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 静默忽略
  }
}
