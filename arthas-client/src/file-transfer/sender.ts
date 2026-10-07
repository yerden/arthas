/**
 * @file sender.ts — 文件发送引擎（核心发送流程）
 *
 * 本文件是文件传输模块的「发送端核心」，负责将用户选择的文件：
 * 1. 加密元数据（文件名、大小、MIME 类型等）并发送给服务器
 * 2. 流式分片 → 逐片加密 → 通过 WebSocket 发送
 * 3. 发送完成信号
 * 4. 在聊天列表中插入文件消息占位符（乐观渲染）
 * 5. 全程更新传输状态（进度、错误）
 *
 * 📚 学习要点: 发送引擎的职责边界
 * sender.ts 只负责「执行发送」，不负责「决定何时发送」。
 * 发送时机由 fileTransferStore 的 processQueue() 控制：
 * - 用户选择文件 → initiateTransfer() 创建状态并加入队列
 * - processQueue() 检测到无活跃发送 → 取出队列头部 → 调用 sender.sendFile()
 * - sendFile() 完成/失败后 → 清理状态 → 触发 processQueue() 处理下一个
 *
 * 这种分离确保了：
 * - 队列逻辑集中在 store 中（单一数据源）
 * - 发送逻辑独立可测试（不依赖 UI 交互）
 * - 错误处理有明确的边界（sender 内部捕获，通过 store 通知 UI）
 *
 * @module file-transfer/sender
 * @see fileTransferStore.ts — 队列调度和状态管理
 * @see chunker.ts — 流式分片
 * @see encryptChunk.ts — 分片加密
 * @see design.md — 发送引擎架构和流控设计
 */

import { send, getWs, isConnected } from '../network/websocket';
import {
  MSG_SEND_FILE_META,
  MSG_SEND_FILE_CHUNK,
  MSG_SEND_FILE_COMPLETE,
  type ChatFileMessage,
  type SendFileMetaData,
  type SendFileChunkData,
  type SendFileCompleteData,
} from '../network/protocol';
import { toBase64Url } from '../crypto/utils';
import { streamChunks } from './chunker';
import { encryptChunk } from './encryptChunk';
import { generateThumbnail } from './thumbnail';
import { useFileTransferStore, triggerProcessQueue, consumeExtraMetadata } from './fileTransferStore';
import { generateChatMessageId } from './chatMessageId';
import { useChatStore } from '../stores/chatStore';
import {
  type FileMetadata,
  type TransferStatus,
  MAX_FILE_SIZE,
  CHUNK_SIZE,
} from './types';

// ============================================================================
// 模块级状态：File 引用存储
// ============================================================================

/**
 * 文件引用映射：transferId → File 对象。
 *
 * 📚 学习要点: 为什么使用模块级 Map 而非 Zustand Store？
 * File 对象是浏览器提供的不可序列化对象（包含文件句柄和磁盘引用），
 * 无法存储在 Zustand state 中（Zustand 使用 JSON-like 的浅拷贝更新）。
 * 即使强行存储，也无法在 DevTools 中查看或持久化。
 *
 * 使用模块级 Map 的优势：
 * 1. File 对象保持原始引用（不被拷贝或序列化）
 * 2. 生命周期与传输一致：传输完成/失败后手动清理
 * 3. 不触发 React 重渲染（File 引用变化不需要 UI 更新）
 * 4. 内存可控：每个 File 对象只是磁盘文件的引用（几十字节），不占用大量内存
 */
const fileRefs = new Map<string, File>();

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 基础分片间延迟：10ms。
 *
 * 📚 学习要点: 为什么需要分片间延迟？
 * 如果不加延迟，发送方会以 CPU 加密速度连续发送 80 个 chunk（5MB 文件），
 * 这会导致：
 * 1. WebSocket 发送缓冲区快速填满（bufferedAmount 飙升）
 * 2. 文本消息被阻塞（用户发送的聊天消息排在大量 chunk 后面）
 * 3. 服务器端 send channel 可能溢出（虽然已有背压机制，但预防优于治疗）
 *
 * 10ms 延迟的效果：
 * - 80 个 chunk × 10ms = 800ms 额外延迟（对 5MB 文件可接受）
 * - 每 10ms 有一个"间隙"让文本消息插入发送队列
 * - 给浏览器事件循环喘息空间（避免长时间占用主线程）
 *
 * @see design.md — 客户端发送限速
 * @see requirements.md — Requirement 3.6, NFR-2
 */
const BASE_CHUNK_DELAY_MS = 10;

/**
 * 最大分片间延迟：100ms。
 *
 * 📚 学习要点: 为什么设置上限？
 * 自适应延迟可能因为 bufferedAmount 过高或 RTT 飙升而计算出很大的延迟值。
 * 但延迟过大会导致传输速度过慢（用户体验差）。
 * 100ms 上限确保即使在最差网络条件下，5MB 文件也能在 8s 内完成发送：
 * 80 chunks × 100ms = 8000ms（加上加密时间约 8-9s）。
 *
 * @see design.md — 客户端发送限速
 */
const MAX_CHUNK_DELAY_MS = 100;

/**
 * WebSocket 发送缓冲区阈值：64KB。
 *
 * 📚 学习要点: WebSocket.bufferedAmount 语义
 * `WebSocket.bufferedAmount` 是浏览器维护的发送队列中尚未发送到网络的字节数。
 * 当这个值超过 64KB 时，说明网络发送速度跟不上应用层的写入速度。
 * 此时应该主动降低发送速率，避免：
 * 1. 浏览器内存持续增长（bufferedAmount 无上限）
 * 2. 文本消息被大量 chunk 数据阻塞
 * 3. 最终触发浏览器的 WebSocket 关闭（某些浏览器在 buffer 过大时会断开）
 *
 * 64KB 的选择依据：
 * - 等于一个 chunk 的大小（加密后约 65KB）
 * - 如果 buffer 中积压了超过一个 chunk，说明网络已经跟不上
 * - 这是一个保守的阈值，确保及时响应网络变化
 */
const BUFFER_THRESHOLD = 65536; // 64KB

// ============================================================================
// 流控状态：RTT 滑动窗口
// ============================================================================

/**
 * 📚 学习要点: 基于 RTT 的拥塞检测
 * `bufferedAmount` 只能检测本地发送队列的积压，无法感知网络链路的拥塞。
 * 例如：bufferedAmount 为 0（数据已交给 OS 网络栈），但网络实际已拥塞。
 *
 * 利用现有的 Ping/Pong 机制测量 RTT（Round-Trip Time），
 * 当 RTT 持续增大时，说明网络拥塞正在发生，应主动降低发送速率。
 * 这类似于 TCP 的拥塞控制思想（但更简化）。
 *
 * 📚 学习要点: 简化版拥塞控制 vs TCP AIMD
 * TCP 使用复杂的 AIMD（Additive Increase Multiplicative Decrease）算法：
 * - 加性增：每个 RTT 窗口增加 1 个 MSS（慢慢加速）
 * - 乘性减：检测到丢包时窗口减半（快速减速）
 * - 需要精确的丢包检测（三次重复 ACK 或超时）
 * - 需要维护拥塞窗口（cwnd）和慢启动阈值（ssthresh）
 *
 * 我们的简化策略：
 * - 维护最近 5 次 RTT 的滑动窗口
 * - 如果最新 RTT > 平均 RTT × 1.5，认为网络拥塞，增加延迟倍数
 * - 如果最新 RTT < 平均 RTT × 0.8，认为网络恢复，减少延迟倍数
 * - 不需要精确的拥塞控制，只需要一个"网络变差了"的信号
 *
 * 为什么这样就够了？
 * 1. 文件传输是短暂的（5MB 最多 80 个 chunk，几秒完成）
 * 2. 我们不需要最大化吞吐量（不是下载工具）
 * 3. 主要目标是避免拥塞恶化，而非精确控制速率
 * 4. 配合 bufferedAmount 检测，两个信号互补
 */

/** RTT 滑动窗口大小：保留最近 5 个 RTT 样本 */
const RTT_WINDOW_SIZE = 5;

/** 拥塞判定因子：最新 RTT > 平均 RTT × 1.5 时认为拥塞 */
const RTT_CONGESTION_FACTOR = 1.5;

/** 恢复判定因子：最新 RTT < 平均 RTT × 0.8 时认为恢复 */
const RTT_RECOVERY_FACTOR = 0.8;

/** RTT 历史记录（滑动窗口） */
let rttHistory: number[] = [];

/**
 * RTT 拥塞倍数：基于 RTT 趋势动态调整的延迟乘数。
 * - 1.0 = 正常（无拥塞）
 * - 最大 3.0 = 严重拥塞（延迟增加到 3 倍）
 */
let rttBasedMultiplier = 1.0;

// ============================================================================
// 离线检测状态
// ============================================================================

/**
 * 📚 学习要点: 协作式流控（Cooperative Flow Control）
 * 文件传输的流控是「协作式」的，由多个层级共同参与：
 *
 * 1. 客户端主动限速（本文件实现）：
 *    - bufferedAmount 检测：本地发送队列积压时降速
 *    - RTT 趋势检测：网络拥塞时降速
 *    - 离线暂停：网络断开时完全暂停
 *
 * 2. 服务器端背压（server-side backpressure）：
 *    - SendFileData 5s 超时：慢接收方不拖住整个系统
 *    - 1 active transfer per client：防止单客户端占用过多资源
 *
 * 3. 浏览器/OS 层：
 *    - TCP 拥塞控制：底层自动调节发送窗口
 *    - WebSocket 帧控制：浏览器自动分帧
 *
 * 这三层协作确保了：
 * - 正常网络：10ms 延迟，快速传输
 * - 轻度拥塞：延迟增加到 30-50ms，平滑降速
 * - 严重拥塞：延迟增加到 100ms（上限），避免恶化
 * - 网络断开：完全暂停，等待恢复或超时失败
 */

/** 是否因网络离线而暂停发送 */
let isPaused = false;

/** 离线检测是否已初始化（防止重复注册事件监听器） */
let offlineDetectionInitialized = false;

/** 离线超时定时器句柄（未激活时为 null） */
let offlineTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** 浏览器进入离线状态的时间戳（在线时为 0） */
let offlineStartTime = 0;

/** 离线超时时长（毫秒）：60 秒无网络则失败传输 */
export const OFFLINE_TIMEOUT_MS = 60_000;

// ============================================================================
// 流控公开 API
// ============================================================================

/**
 * 记录最新的 RTT 值（从 Ping/Pong 机制获取）。
 *
 * 📚 学习要点: RTT 测量来源
 * 此函数由 websocket.ts 的 Ping 处理逻辑调用。
 * 当客户端收到服务器的 MSG_PING（包含服务器发送时间戳 t），
 * 可以计算 RTT ≈ Date.now() - t（假设时钟同步误差可接受）。
 *
 * 注意：这不是精确的 RTT（受时钟偏差影响），但对于拥塞检测足够：
 * 我们关心的是 RTT 的「趋势」（增大/减小），而非绝对值。
 * 即使时钟有固定偏差，趋势仍然是准确的。
 *
 * @param rtt - 测量到的 RTT 值（毫秒）
 *
 * @example
 * ```typescript
 * // 在 websocket.ts 的 handleRawMessage 中，处理 MSG_PING 时：
 * import { recordRtt } from '../file-transfer/sender';
 * const rtt = Date.now() - pingData.t;
 * if (rtt > 0) recordRtt(rtt);
 * ```
 */
export function recordRtt(rtt: number): void {
  // 忽略无效值（负数或异常大的值可能是时钟偏差导致）
  if (rtt <= 0 || rtt > 30000) return;

  rttHistory.push(rtt);
  if (rttHistory.length > RTT_WINDOW_SIZE) {
    rttHistory.shift(); // 移除最旧的样本，保持窗口大小
  }

  // 数据不足时不调整（至少需要 3 个样本才能判断趋势）
  if (rttHistory.length < 3) return;

  // 计算滑动窗口平均 RTT
  const avgRtt = rttHistory.reduce((a, b) => a + b, 0) / rttHistory.length;
  const latestRtt = rttHistory[rttHistory.length - 1];

  if (latestRtt > avgRtt * RTT_CONGESTION_FACTOR) {
    // 网络拥塞：增加延迟倍数（每次增加 50%，最多 3x）
    // 📚 学习要点: 乘性增加（Multiplicative Increase）
    // 拥塞时快速增加延迟，避免继续恶化网络状况。
    // 这类似于 TCP 的乘性减（但我们是增加延迟而非减小窗口）。
    rttBasedMultiplier = Math.min(rttBasedMultiplier * 1.5, 3.0);
  } else if (latestRtt < avgRtt * RTT_RECOVERY_FACTOR) {
    // 网络恢复：减少延迟倍数（每次减少 30%，最低 1x）
    // 📚 学习要点: 乘性减少（Multiplicative Decrease of multiplier）
    // 恢复时逐步减少延迟，避免突然加速导致再次拥塞。
    // 比 TCP 的加性增更激进，因为我们的传输时间短，需要快速恢复。
    rttBasedMultiplier = Math.max(rttBasedMultiplier * 0.7, 1.0);
  }
  // 如果 RTT 在正常范围内（0.8x ~ 1.5x 平均值），不调整倍数（保持稳定）
}

/**
 * 重置 RTT 状态（用于测试或新传输开始时）。
 *
 * @internal 仅供测试使用
 */
export function resetRttState(): void {
  rttHistory = [];
  rttBasedMultiplier = 1.0;
}

/**
 * 获取当前 RTT 倍数（用于测试验证）。
 *
 * @internal 仅供测试使用
 */
export function getRttMultiplier(): number {
  return rttBasedMultiplier;
}

/**
 * 获取当前暂停状态（用于测试验证）。
 *
 * @internal 仅供测试使用
 */
export function getIsPaused(): boolean {
  return isPaused;
}

/**
 * 设置暂停状态（用于测试）。
 *
 * @internal 仅供测试使用
 */
export function setIsPaused(paused: boolean): void {
  isPaused = paused;
}

/**
 * 重置离线检测状态（仅供测试使用）。
 * 清除超时定时器、重置离线起始时间、重置初始化标志以允许重新 setup。
 *
 * @internal 仅供测试使用
 */
export function resetOfflineDetectionState(): void {
  if (offlineTimeoutId !== null) {
    clearTimeout(offlineTimeoutId);
    offlineTimeoutId = null;
  }
  offlineStartTime = 0;
  isPaused = false;
  offlineDetectionInitialized = false;
}

/**
 * 获取当前离线超时定时器句柄（用于测试断言）。
 *
 * @internal 仅供测试使用
 */
export function getOfflineTimeoutId(): ReturnType<typeof setTimeout> | null {
  return offlineTimeoutId;
}

/**
 * 获取离线起始时间戳（用于测试断言）。
 *
 * @internal 仅供测试使用
 */
export function getOfflineStartTime(): number {
  return offlineStartTime;
}

/**
 * 初始化离线检测：监听 window 的 offline/online 事件。
 *
 * 📚 学习要点: navigator.onLine 与 offline 事件
 * 浏览器提供了网络状态检测 API：
 * - `navigator.onLine`: 当前是否在线（布尔值）
 * - `window.addEventListener('offline', ...)`: 网络断开时触发
 * - `window.addEventListener('online', ...)`: 网络恢复时触发
 *
 * 注意：这些 API 不完全可靠（某些情况下 onLine=true 但实际无法访问服务器），
 * 但作为"快速反馈"机制，比等待 WebSocket 超时（可能需要 30s+）要好得多。
 *
 * 📚 学习要点: 为什么主动暂停比被动超时好？
 * 被动超时：网络断开 → 继续发送 chunk → bufferedAmount 增长 →
 *          最终 WebSocket 超时关闭 → 传输标记失败（可能需要 10-30s）
 * 主动暂停：网络断开 → 立即暂停发送 → 显示"网络断开，等待重连..."
 *          → 网络恢复 → 检查 WebSocket 状态 → 继续或标记失败（<1s 反馈）
 *
 * 此函数应在应用启动时调用一次（如 App.tsx 或 main.tsx 中）。
 * 使用 `offlineDetectionInitialized` 标志防止重复注册。
 */
export function setupOfflineDetection(): void {
  // 防止重复初始化（React StrictMode 或 HMR 可能多次调用）
  if (offlineDetectionInitialized) return;
  offlineDetectionInitialized = true;

  window.addEventListener('offline', () => {
    isPaused = true;

    // Guard: do not start a duplicate timer if one is already running
    if (offlineTimeoutId !== null) return;

    offlineStartTime = Date.now();

    offlineTimeoutId = setTimeout(() => {
      offlineTimeoutId = null; // Timer has fired, clear handle

      // If an active send exists, fail it with a timeout error
      const { activeSendId } = useFileTransferStore.getState();
      if (activeSendId) {
        console.warn('[FileTransfer] Offline timeout: failing active send', activeSendId);
        failTransfer(activeSendId, 'Offline for more than 60 seconds, transfer timed out', 'sending');
      }
      // If no active send, this is a no-op
    }, OFFLINE_TIMEOUT_MS);

    const { activeSendId } = useFileTransferStore.getState();
    if (activeSendId) {
      console.warn('[FileTransfer] Network offline, pausing transfer:', activeSendId);
    }
  });

  window.addEventListener('online', () => {
    isPaused = false;

    // Clear the offline timeout if active
    if (offlineTimeoutId !== null) {
      clearTimeout(offlineTimeoutId);
      offlineTimeoutId = null;
    }
    offlineStartTime = 0;

    // 检查 WebSocket 是否仍然连接
    if (isConnected()) {
      // WebSocket 仍在，发送循环会自动恢复（isPaused 已设为 false）
      console.log('[FileTransfer] Network online, resuming transfer');
    } else {
      // WebSocket 已断开，传输将在发送循环中因连接检查而失败
      // 不需要在这里做额外处理，websocket.ts 的重连逻辑会处理
      console.log('[FileTransfer] Network online but WebSocket disconnected, waiting for reconnect');
    }
  });
}

/**
 * 计算基于 bufferedAmount 的自适应延迟。
 *
 * 📚 学习要点: WebSocket.bufferedAmount 语义
 * `bufferedAmount` 是一个只读属性，表示通过 `send()` 调用排队但尚未传输到网络的数据字节数。
 * 它包括所有排队的数据（包括 WebSocket 帧头），但不包括已经发送到网络的数据。
 *
 * 当 bufferedAmount > 0 时，说明网络发送速度跟不上应用层的写入速度。
 * 我们使用线性比例增加延迟：
 * - bufferedAmount = 0: 返回 BASE_CHUNK_DELAY_MS (10ms)
 * - bufferedAmount = BUFFER_THRESHOLD (64KB): 返回 10ms（刚好到阈值）
 * - bufferedAmount = 2 × BUFFER_THRESHOLD (128KB): 返回 20ms
 * - bufferedAmount = 6.4 × BUFFER_THRESHOLD (~400KB): 返回 MAX_CHUNK_DELAY_MS (100ms)
 *
 * 这种线性增长确保了：
 * - 轻度积压时温和降速（不过度反应）
 * - 严重积压时快速降速（防止 buffer 无限增长）
 * - 有明确的上限（100ms），不会让传输变得过慢
 *
 * @returns 建议的延迟毫秒数（10ms ~ 100ms）
 */
function getAdaptiveDelay(): number {
  const ws = getWs();
  if (!ws) return BASE_CHUNK_DELAY_MS;

  if (ws.bufferedAmount > BUFFER_THRESHOLD) {
    // 线性比例增加延迟：bufferedAmount 越大，延迟越长
    const ratio = ws.bufferedAmount / BUFFER_THRESHOLD;
    return Math.min(
      BASE_CHUNK_DELAY_MS * ratio,
      MAX_CHUNK_DELAY_MS
    );
  }

  return BASE_CHUNK_DELAY_MS;
}

/**
 * 综合自适应延迟：结合 bufferedAmount 和 RTT 两个信号。
 *
 * 📚 学习要点: 多信号融合策略
 * 两个信号各有优缺点：
 * - bufferedAmount: 反映本地发送队列状态，响应快但只能看到本地积压
 * - RTT 趋势: 反映端到端网络状态，能感知远端拥塞但有延迟
 *
 * 融合策略：取两者的乘积效果（bufferDelay × rttMultiplier），
 * 但最终结果不超过 MAX_CHUNK_DELAY_MS。
 * 这确保了：
 * - 任一信号检测到问题都会降速
 * - 两个信号同时报警时降速更激进
 * - 有明确的上限保护用户体验
 *
 * @returns 最终建议的延迟毫秒数（10ms ~ 100ms）
 */
function getAdaptiveDelayWithRtt(): number {
  const bufferDelay = getAdaptiveDelay();
  return Math.min(bufferDelay * rttBasedMultiplier, MAX_CHUNK_DELAY_MS);
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 存储文件引用，供后续 sendFile() 使用。
 * 在 fileTransferStore.initiateTransfer() 中调用。
 *
 * @param transferId - 传输唯一标识符
 * @param file - 用户选择的 File 对象
 *
 * @example
 * ```typescript
 * const transferId = generateTransferId();
 * storeFileRef(transferId, file);
 * // 后续 processQueue() 触发 sendFile() 时，通过 transferId 获取 File
 * ```
 */
export function storeFileRef(transferId: string, file: File): void {
  fileRefs.set(transferId, file);
}

/**
 * 移除文件引用，释放 File 对象。
 * 在传输完成、失败或取消后调用，防止内存泄漏。
 *
 * 此函数是幂等的：对同一 transferId 多次调用是安全的（Map.delete 对不存在的 key 为空操作）。
 * 这一特性很重要，因为离线超时、.catch() 处理器、sendFile 的 finally 块都可能调用此函数。
 *
 * 📚 学习要点: File 对象的内存管理
 * 虽然 File 对象本身很小（只是磁盘文件的引用），
 * 但保持引用会阻止浏览器释放相关的内部资源（如文件描述符）。
 * 及时清理确保系统资源不被无谓占用。
 *
 * @param transferId - 要清理的传输 ID
 */
export function removeFileRef(transferId: string): void {
  fileRefs.delete(transferId);
}

/**
 * 执行文件发送的完整流程。
 *
 * 此函数由 fileTransferStore 的 processQueue() 在传输变为活跃时调用。
 * 它执行以下步骤：
 * 1. 获取 File 引用和传输状态
 * 2. 在聊天列表中插入文件消息占位符（乐观渲染）
 * 3. 加密文件元数据并发送 MSG_SEND_FILE_META
 * 4. 流式分片 → 加密 → 发送 MSG_SEND_FILE_CHUNK（带 10ms 延迟）
 * 5. 发送 MSG_SEND_FILE_COMPLETE
 * 6. 更新传输状态为 complete
 *
 * 📚 学习要点: 乐观渲染（Optimistic Rendering）
 * 在传输开始时就在聊天列表中显示文件消息气泡（status: sending），
 * 而不是等传输完成后再显示。这给用户即时反馈："文件正在发送中"。
 * 如果传输失败，气泡会更新为错误状态（而非消失），
 * 让用户知道发生了什么并可以重试。
 *
 * 📚 学习要点: 错误边界（Error Boundary）
 * 整个发送流程被 try/catch 包裹：
 * - 任何步骤失败（加密错误、WebSocket 断开等）都会被捕获
 * - 捕获后：标记传输为 failed → 清理资源 → 触发 processQueue 处理下一个
 * - 这确保了单个传输的失败不会阻塞整个队列
 *
 * @param transferId - 要发送的传输 ID（已由 processQueue 设为 activeSendId）
 * @param roomKey - 房间 AES-256-GCM 密钥，用于加密元数据和分片
 *
 * @example
 * ```typescript
 * // 由 processQueue() 内部调用：
 * const { roomKey } = useChatStore.getState();
 * if (roomKey) {
 *   sendFile(nextTransferId, roomKey);
 * }
 * ```
 */
export async function sendFile(transferId: string, roomKey: CryptoKey): Promise<void> {
  // Step 1: 获取 File 引用和传输状态
  const file = fileRefs.get(transferId);
  if (!file) {
    failTransfer(transferId, 'File reference lost, cannot send');
    return;
  }

  const transfer = useFileTransferStore.getState().transfers.get(transferId);
  if (!transfer) {
    failTransfer(transferId, 'Transfer state lost');
    return;
  }

  // Step 2: 二次验证文件大小（防御性编程）
  // initiateTransfer 已验证过，但 File 对象可能在排队期间被修改（极端情况）
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    failTransfer(transferId, 'Invalid file size');
    return;
  }

  try {
    // Step 3: 在聊天列表中插入文件消息占位符（乐观渲染）
    // 📚 学习要点: 语音消息的占位符由 voiceSender 提前插入
    // 如果 transfer.chatMessageId 已设置（语音消息在 voiceSender 中提前插入了占位符），
    // 跳过此步骤，避免重复插入聊天消息。
    // 普通文件传输的 chatMessageId 在 initiateTransfer 时为空字符串，需要在此处插入。
    if (!transfer.chatMessageId) {
      const chatMessageId = insertChatFileMessage(transferId, file);
      updateTransferMeta(transferId, chatMessageId);
    }

    // Step 4: 加密文件元数据并发送 MSG_SEND_FILE_META
    // 📚 学习要点: consumeExtraMetadata 获取语音消息的额外字段
    // 语音消息通过 initiateTransfer 的 extraMetadata 参数存储了 { isVoice: true, duration }。
    // 此处取出并传递给 sendEncryptedMetadata，合并到加密的 FileMetadata 对象中。
    // 普通文件传输没有 extraMetadata，consumeExtraMetadata 返回 undefined（不影响）。
    const extraFields = consumeExtraMetadata(transferId);
    await sendEncryptedMetadata(transferId, file, roomKey, extraFields);

    // Step 5: 流式分片 → 加密 → 发送所有 chunk
    await sendAllChunks(transferId, file, roomKey);

    // Step 6: 检查传输是否被取消（发送循环中可能被用户取消）
    const currentState = useFileTransferStore.getState().transfers.get(transferId);
    if (currentState?.status === 'cancelled') {
      // 用户已取消，不发送 COMPLETE，直接清理
      removeFileRef(transferId);
      return;
    }

    // Step 7: 发送传输完成信号
    const completeData: SendFileCompleteData = { transferId };
    send(MSG_SEND_FILE_COMPLETE, completeData);

    // Step 8: 更新传输状态为 complete
    completeTransfer(transferId);

  } catch (error) {
    // 错误处理：标记传输为 failed
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during send';
    failTransfer(transferId, errorMessage);
  } finally {
    // 清理 File 引用（无论成功或失败）
    removeFileRef(transferId);
  }
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 延迟函数：返回一个在指定毫秒后 resolve 的 Promise。
 *
 * 📚 学习要点: 为什么用 Promise 包装 setTimeout？
 * async/await 语法只能 await Promise 对象。
 * 将 setTimeout 包装为 Promise 后，可以在 async 函数中使用：
 * `await delay(10)` — 暂停执行 10ms，然后继续下一行。
 * 这比回调嵌套（callback hell）或手动管理定时器更清晰。
 *
 * @param ms - 延迟毫秒数
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 在聊天列表中插入文件消息占位符。
 *
 * 📚 学习要点: 占位符模式的实现
 * 文件消息占位符在传输开始时就插入聊天列表，实现「乐观渲染」：
 * - 用户立即看到"文件正在发送"的气泡（无需等待传输完成）
 * - 气泡通过 transferId 引用 fileTransferStore 中的实时状态
 * - FileMessage.tsx 组件订阅 transferId 对应的进度/状态变化
 *
 * 为什么在 sender.ts 中插入而非 fileTransferStore 中？
 * - sender.ts 知道确切的发送时机（processQueue 触发后）
 * - 避免在排队阶段就插入占位符（用户可能取消排队中的传输）
 * - 保持 fileTransferStore 的职责纯粹（状态管理，不操作 chatStore）
 *
 * @param transferId - 传输唯一标识符
 * @param file - 文件对象（用于提取文件名、大小、类型）
 * @returns 生成的聊天消息 ID（用于关联传输状态）
 */
function insertChatFileMessage(transferId: string, file: File): string {
  const { myId, myName } = useChatStore.getState();
  const timestamp = Date.now();

  // 生成唯一消息 ID（使用统一的 chatMessageId 生成工具）
  const chatMessageId = generateChatMessageId('file');

  const fileMessage: ChatFileMessage = {
    id: chatMessageId,
    stableId: `${myId ?? 'unknown'}-${timestamp}`,
    senderId: myId ?? '',
    senderName: myName ?? '',
    text: '',  // 文件消息不使用 text 字段
    timestamp,
    isMine: true,
    isSystem: false,
    type: 'file',
    transferId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
  };

  // 插入到 chatStore 的 messages 数组中
  // 📚 学习要点: 跨 Store 操作
  // 这里直接操作 chatStore 的状态，因为文件消息需要出现在聊天流中。
  // Zustand 允许在任何地方通过 .setState() 修改状态，不限于组件内部。
  // 这种模式在需要跨 store 协调时很常见（但应谨慎使用，避免循环依赖）。
  useChatStore.setState((state) => {
    const messages = [...state.messages, fileMessage as unknown as typeof state.messages[0]];
    // 遵守 MAX_MESSAGES 限制（与 chatStore 内部逻辑一致）
    return {
      messages: messages.length > 200 ? messages.slice(-200) : messages,
    };
  });

  return chatMessageId;
}

/**
 * 更新传输状态的元信息（chatMessageId、发送方信息、接收方数量）。
 *
 * @param transferId - 传输 ID
 * @param chatMessageId - 聊天消息占位符 ID
 */
function updateTransferMeta(transferId: string, chatMessageId: string): void {
  const { myId, myName, members } = useChatStore.getState();

  useFileTransferStore.setState((state) => {
    const transfers = new Map(state.transfers);
    const transfer = transfers.get(transferId);
    if (transfer) {
      transfers.set(transferId, {
        ...transfer,
        chatMessageId,
        senderId: myId ?? '',
        senderName: myName ?? '',
        // 总接收人数 = 房间成员数 - 1（排除自己）
        totalReceivers: Math.max(0, members.length - 1),
      });
    }
    return { transfers };
  });
}

/**
 * 加密文件元数据并通过 WebSocket 发送 MSG_SEND_FILE_META。
 *
 * 📚 学习要点: 元数据加密策略
 * 文件元数据（文件名、大小、MIME 类型等）使用与聊天消息相同的加密模式：
 * - 将 FileMetadata 对象序列化为 JSON 字符串
 * - 使用 AES-256-GCM + 随机 96-bit IV 加密
 * - IV 以 base64url 字符串传输（只发送一次，方便调试）
 * - 密文以 Uint8Array 传输（msgpack bin 格式，比 base64 string 更紧凑）
 *
 * 与 encryptMessage() 的区别：
 * - encryptMessage: 返回 { iv: string, ciphertext: string }（两者都是 base64url）
 * - 这里：返回 { iv: string, ciphertext: Uint8Array }（iv 是 base64url，密文是原始二进制）
 * 原因：密文通过 msgpack bin 格式传输，避免 base64 的 33% 膨胀。
 *
 * 📚 学习要点: extraFields 扩展点设计
 * 语音消息需要在加密 metadata 中注入 `isVoice: true` 和 `duration` 字段，
 * 但 sendEncryptedMetadata() 原本只从 File 对象构造固定的 FileMetadata。
 * 通过增加可选的 `extraFields` 参数，调用方可以注入任意额外字段：
 * - 语音消息: { isVoice: true, duration: 5 }
 * - 未来扩展: 任何需要在加密 metadata 中携带的自定义字段
 *
 * 这些字段在加密的 ciphertext 内部，服务器无法看到（零知识保持不变）。
 * 接收方解密 metadata 后可以检查这些字段来决定渲染方式。
 * 旧客户端不认识额外字段会直接忽略（向后兼容）。
 *
 * @param transferId - 传输 ID
 * @param file - 文件对象
 * @param roomKey - 房间加密密钥
 * @param extraFields - 可选的额外字段，合并到 FileMetadata 中一起加密发送。
 *                      用于语音消息注入 isVoice/duration 等标识字段。
 *                      默认 undefined，不影响现有文件传输调用。
 */
async function sendEncryptedMetadata(
  transferId: string,
  file: File,
  roomKey: CryptoKey,
  extraFields?: Record<string, unknown>
): Promise<void> {
  // 1. 构建文件元数据对象
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // 📚 学习要点: 缩略图生成时机
  // 在发送元数据之前生成缩略图，将其包含在 FileMetadata 中一起加密发送。
  // 这样接收方在收到 metadata 时就能立即显示图片预览，无需等待完整文件传输。
  // generateThumbnail() 对非图片文件返回 null，不影响非图片文件的传输流程。
  const thumbnail = await generateThumbnail(file);

  // 📚 学习要点: 对象展开（Spread）合并策略
  // 使用 `...extraFields` 将额外字段合并到 metadata 对象中。
  // 展开操作放在基础字段之后，意味着 extraFields 中的同名字段会覆盖基础字段。
  // 但实际使用中，extraFields 只包含新增字段（如 isVoice、duration），
  // 不会与基础字段冲突。如果 extraFields 为 undefined，展开操作无效果（安全）。
  const metadata: FileMetadata = {
    transferId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    totalChunks,
    thumbnail: thumbnail ?? undefined,
    ...extraFields,
  };

  // 📚 学习要点: 发送方也存储缩略图 data URL
  // 发送方在生成缩略图后，将其转换为 data URL 存储到 TransferState 中，
  // 这样发送方的 FileMessage 组件也能立即显示缩略图预览。
  if (thumbnail) {
    const thumbnailBlob = new Blob([thumbnail.buffer as ArrayBuffer], { type: 'image/jpeg' });
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve) => {
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(thumbnailBlob);
    });

    useFileTransferStore.setState((state) => {
      const transfers = new Map(state.transfers);
      const transfer = transfers.get(transferId);
      if (transfer) {
        transfers.set(transferId, { ...transfer, thumbnail: dataUrl });
      }
      return { transfers };
    });
  }

  // 2. 将元数据序列化为 JSON 字符串，然后编码为 UTF-8 字节
  const metadataJson = JSON.stringify(metadata);
  const metadataBytes = new TextEncoder().encode(metadataJson);

  // 3. 生成随机 96-bit IV 并加密
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    roomKey,
    metadataBytes
  );

  // 4. 构建发送数据：iv 为 base64url string，ciphertext 为 Uint8Array
  const sendData: SendFileMetaData = {
    transferId,
    iv: toBase64Url(iv.buffer),
    ciphertext: new Uint8Array(ciphertextBuffer),
  };

  // 5. 通过 WebSocket 发送
  send(MSG_SEND_FILE_META, sendData);
}

/**
 * 流式发送所有加密分片。
 *
 * 📚 学习要点: 流式发送的内存优势
 * 使用 streamChunks() 异步生成器逐片读取文件：
 * - 内存中同时只有 1 个明文 chunk（64KB）+ 1 个加密后的 chunk（~64KB）
 * - 峰值内存 ≈ 128KB，与文件大小无关
 * - 每个 chunk 发送后，前一个 chunk 的内存可被 GC 回收
 *
 * 📚 学习要点: 取消检查点（Cancellation Checkpoint）
 * 在每次循环迭代开始时检查传输状态是否被取消。
 * 这是「协作式取消」模式：发送循环主动检查取消信号，
 * 而非被外部强制中断（JavaScript 没有线程中断机制）。
 * 最坏情况下，取消响应延迟 = 1 个 chunk 的加密时间 + 延迟 ≈ 11-100ms。
 *
 * 📚 学习要点: 离线暂停机制
 * 在每个 chunk 发送前检查 isPaused 标志：
 * - 如果网络离线（isPaused = true），进入等待循环
 * - 每 500ms 检查一次网络状态
 * - 如果 60s 内网络未恢复，抛出错误终止传输
 * - 网络恢复后（isPaused = false），继续发送下一个 chunk
 *
 * 这种「轮询等待」模式比事件驱动更简单：
 * - 不需要 Promise resolve/reject 的复杂协调
 * - 500ms 轮询间隔对用户体验无影响（暂停期间本来就不发送数据）
 * - 超时检查自然集成在等待循环中
 *
 * @param transferId - 传输 ID
 * @param file - 文件对象
 * @param roomKey - 房间加密密钥
 */
async function sendAllChunks(
  transferId: string,
  file: File,
  roomKey: CryptoKey
): Promise<void> {
  for await (const { index, data } of streamChunks(file)) {
    // 取消检查点：每个 chunk 发送前检查传输是否被取消
    const currentTransfer = useFileTransferStore.getState().transfers.get(transferId);
    if (!currentTransfer || currentTransfer.status === 'cancelled') {
      // 传输已被取消，停止发送循环
      return;
    }

    // 离线暂停：等待网络恢复或超时失败
    // 📚 学习要点: 离线等待的超时策略
    // 使用 60s 超时（与接收方的 Transfer_Timeout 一致）。
    // 如果网络断开超过 60s，接收方也会因为超时而标记传输失败，
    // 所以发送方继续等待没有意义。
    if (isPaused) {
      const pauseStartTime = Date.now();
      while (isPaused) {
        await delay(500); // 每 500ms 检查一次

        // 超时检查：离线超过 60s 则放弃传输
        if (Date.now() - pauseStartTime > 60_000) {
          throw new Error('Disconnected for more than 60 seconds, transfer failed');
        }

        // 再次检查取消状态（用户可能在离线等待期间取消传输）
        const checkTransfer = useFileTransferStore.getState().transfers.get(transferId);
        if (!checkTransfer || checkTransfer.status === 'cancelled') {
          return;
        }
      }

      // 网络恢复后，检查 WebSocket 是否仍然连接
      if (!isConnected()) {
        throw new Error('Connection lost, transfer failed');
      }
    }

    // 1. 加密当前 chunk
    // 📚 学习要点: 每个 chunk 使用独立的随机 IV
    // encryptChunk 内部调用 crypto.getRandomValues(new Uint8Array(12))
    // 生成唯一的 96-bit IV，确保 AES-GCM 的安全性要求（同一密钥下 IV 不重复）
    const { iv, ciphertext } = await encryptChunk(roomKey, data);

    // 2. 构建并发送 chunk 消息
    const chunkData: SendFileChunkData = {
      transferId,
      index,
      iv,
      data: ciphertext,
    };
    send(MSG_SEND_FILE_CHUNK, chunkData);

    // 3. 更新传输进度
    updateChunkProgress(transferId, index);

    // 4. 自适应延迟：结合 bufferedAmount 和 RTT 两个信号
    // 📚 学习要点: 协作式流控
    // 自适应延迟让出主线程控制权，允许：
    // - 浏览器处理 UI 事件（保持界面响应）
    // - 文本消息插入 WebSocket 发送队列（不被文件传输阻塞）
    // - 服务器有时间处理和转发前一个 chunk
    // 延迟值根据网络状况动态调整（10ms ~ 100ms）
    await delay(getAdaptiveDelayWithRtt());
  }
}

/**
 * 更新传输进度：已发送的 chunk 数量。
 *
 * @param transferId - 传输 ID
 * @param chunkIndex - 刚发送的 chunk 索引（0-based）
 */
function updateChunkProgress(transferId: string, chunkIndex: number): void {
  useFileTransferStore.setState((state) => {
    const transfers = new Map(state.transfers);
    const transfer = transfers.get(transferId);
    if (transfer) {
      transfers.set(transferId, {
        ...transfer,
        receivedChunks: chunkIndex + 1,  // receivedChunks 在发送方表示"已发送的 chunk 数"
        lastReceivedIndex: chunkIndex,
        lastChunkTime: Date.now(),
      });
    }
    return { transfers };
  });
}

/**
 * 标记传输为完成状态，清理活跃发送标记，触发队列处理下一个。
 *
 * @param transferId - 传输 ID
 */
function completeTransfer(transferId: string): void {
  useFileTransferStore.setState((state) => {
    const transfers = new Map(state.transfers);
    const transfer = transfers.get(transferId);
    if (transfer) {
      transfers.set(transferId, {
        ...transfer,
        status: 'complete' as TransferStatus,
      });
    }
    return {
      transfers,
      activeSendId: null,  // 清除活跃发送标记
    };
  });

  // 触发队列处理下一个待发送传输
  triggerProcessQueue();
}

/**
 * 标记传输为失败状态，清理资源，触发队列处理下一个。
 *
 * 此函数是离线超时和 sendFile 内部错误的统一失败处理入口。
 * 通过可选的 `guardStatus` 参数支持幂等保护：
 * - 不传 guardStatus：无条件标记失败（用于 sendFile 内部捕获的错误）
 * - 传入 'sending'：仅当传输仍处于 'sending' 状态时标记失败（用于离线超时和 .catch 处理器，
 *   防止对已完成或已失败的传输重复修改）
 *
 * 📚 学习要点: 失败恢复策略
 * 单个传输失败不应阻塞整个队列。失败处理流程：
 * 1. 更新传输状态为 'failed'（UI 显示错误信息）
 * 2. 清除 activeSendId（允许下一个传输开始）
 * 3. 清理 File 引用（释放资源，幂等操作）
 * 4. 触发 processQueue()（自动开始下一个排队的传输）
 *
 * @param transferId - 传输 ID
 * @param error - 错误描述信息（用户可见）
 * @param guardStatus - 可选的状态守卫：仅当传输处于该状态时才标记失败
 *
 * @internal 导出仅供测试使用；内部由 setupOfflineDetection 超时回调和 sendFile 错误处理调用
 */
export function failTransfer(transferId: string, error: string, guardStatus?: TransferStatus): void {
  useFileTransferStore.setState((state) => {
    const transfers = new Map(state.transfers);
    const transfer = transfers.get(transferId);
    if (transfer && (!guardStatus || transfer.status === guardStatus)) {
      transfers.set(transferId, {
        ...transfer,
        status: 'failed' as TransferStatus,
        error,
      });
    }
    return {
      transfers,
      activeSendId: null,
    };
  });

  removeFileRef(transferId);
  triggerProcessQueue();
}
