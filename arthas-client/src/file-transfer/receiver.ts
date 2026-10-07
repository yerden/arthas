/**
 * @file receiver.ts — 文件接收引擎（核心接收流程）
 *
 * 本文件是文件传输模块的「接收端核心」，负责：
 * 1. 接收并解密文件元数据（handleFileMeta）
 * 2. 逐片接收、解密、存储分片数据（handleFileChunk）
 * 3. 验证完整性并重组文件（handleFileComplete）
 * 4. 处理取消信号（handleFileCancel）
 * 5. 超时检测与内存保护（60s 超时、5MB 缓冲区限制）
 * 6. 处理发送方离开（handleSenderLeft）
 *
 * 📚 学习要点: 接收引擎的职责边界
 * receiver.ts 只负责「处理接收到的数据」，不负责「网络通信」。
 * 消息路由由 fileTransferStore.handleFileMessage() 完成：
 * - chatStore 收到 MSG_RELAY_FILE_* 消息 → 转发给 fileTransferStore
 * - fileTransferStore.handleFileMessage() → 调用 receiver 对应方法
 * - receiver 处理数据 → 更新 fileTransferStore 状态 → UI 自动响应
 *
 * 📚 学习要点: 接收方的内存管理策略
 * 接收方需要在内存中维护 chunk 缓冲区直到文件重组完成：
 * - 每个传输最多 5MB 缓冲区（MAX_FILE_SIZE）
 * - 最多 5 个并发接收（MAX_CONCURRENT_RECEIVES）
 * - 最坏情况内存占用：5 × 5MB = 25MB
 * - 超时（60s 无新 chunk）或缓冲区超限时主动释放内存
 *
 * @module file-transfer/receiver
 * @see fileTransferStore.ts — 状态管理和消息路由
 * @see decryptChunk.ts — 分片解密
 * @see chunker.ts — 文件重组（reassembleChunks）
 * @see design.md — 接收引擎架构
 * @see requirements.md — Requirements 5.1-5.11, 6.3-6.6, 7.1-7.5, 11.1, 11.5, 11.7
 */

import { send } from '../network/websocket';
import {
  MSG_SEND_FILE_ACK,
  type RelayFileMetaData,
  type RelayFileChunkData,
  type RelayFileCompleteData,
  type RelayFileCancelData,
  type ChatFileMessage,
  type ChatVoiceMessage,
  type SendFileAckData,
} from '../network/protocol';
import { fromBase64Url } from '../crypto/utils';
import { decryptChunk } from './decryptChunk';
import { reassembleChunks } from './chunker';
import { sanitizeFileName } from './sanitize';
import { useFileTransferStore, MAX_CONCURRENT_RECEIVES } from './fileTransferStore';
import { bufferEarlyChunk, takeEarlyChunks } from './pendingChunks';
import { generateChatMessageId } from './chatMessageId';
import { useChatStore } from '../stores/chatStore';
import {
  type FileMetadata,
  type TransferState,
  type TransferStatus,
  MAX_FILE_SIZE,
} from './types';

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 接收超时时间：60 秒。
 *
 * 📚 学习要点: 为什么选择 60 秒？
 * - 太短（如 10s）：网络波动可能导致误判超时（特别是大房间广播场景）
 * - 太长（如 5min）：内存被无效传输长时间占用，用户等待体验差
 * - 60s 是平衡点：覆盖了大多数网络恢复场景，同时不会过度占用内存
 * - 服务器端超时为 90s（作为兜底），确保客户端先超时并清理
 *
 * @see requirements.md — Requirement 11.5
 */
const RECEIVE_TIMEOUT_MS = 60_000;

/**
 * metadata 注册完成后，按到达顺序回放在解密窗口期早到的 chunk。
 * @see pendingChunks.ts — 为什么会有早到的 chunk，以及暂存的上限
 */
async function drainEarlyChunks(transferId: string, roomKey: CryptoKey): Promise<void> {
  for (const chunk of takeEarlyChunks(transferId)) {
    await handleFileChunk(chunk, roomKey);
  }
}


/**
 * 接收缓冲区大小上限：5MB (5,242,880 bytes)。
 *
 * 📚 学习要点: 缓冲区限制的安全意义
 * 恶意发送方可能声称文件大小为 1MB（totalChunks=16），
 * 但实际发送远超 16 个 chunk（利用 index 字段伪造）。
 * 缓冲区大小限制确保即使 metadata 被篡改，
 * 接收方的内存占用也不会超过 MAX_FILE_SIZE。
 *
 * @see requirements.md — Requirement 11.1
 */
const MAX_BUFFER_SIZE = MAX_FILE_SIZE;

// ============================================================================
// 模块级状态：超时定时器管理
// ============================================================================

/**
 * 超时定时器映射：transferId → setTimeout handle。
 *
 * 📚 学习要点: 为什么使用模块级 Map 管理定时器？
 * - 定时器 handle 不适合存储在 Zustand state 中（不可序列化）
 * - 每次收到新 chunk 时需要重置定时器（clearTimeout + setTimeout）
 * - 传输完成/取消/失败时需要清除定时器（防止内存泄漏）
 * - 模块级 Map 提供 O(1) 的查找和更新性能
 */
const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 处理收到的文件元数据（MSG_RELAY_FILE_META）。
 *
 * 接收方收到此消息后执行以下步骤：
 * 1. 检查并发接收限制（MAX_CONCURRENT_RECEIVES）
 * 2. 解密 metadata（AES-256-GCM，IV 为 base64url 编码）
 * 3. 验证解密后的 metadata 字段合法性
 * 4. 创建 TransferState（direction='receive', status='receiving'）
 * 5. 分配 chunk 缓冲区：new Array(totalChunks).fill(null)
 * 6. 在聊天列表中插入 ChatFileMessage 占位符
 * 7. 启动 60s 超时定时器
 *
 * 📚 学习要点: 为什么在 handleFileMeta 中就设为 'receiving'？
 * 设计文档中 pending → receiving 的转换发生在"收到首个 chunk"时，
 * 但实际实现中，收到 metadata 就意味着传输已经开始（发送方已在发送 chunk）。
 * 直接设为 'receiving' 简化了状态管理，且 UI 可以立即显示"接收中"状态。
 *
 * @param data - 服务器中转的文件元数据（包含加密的 metadata）
 * @param roomKey - 房间 AES-256-GCM 密钥，用于解密 metadata
 *
 * @see requirements.md — Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 11.1
 */
export async function handleFileMeta(
  data: RelayFileMetaData,
  roomKey: CryptoKey
): Promise<void> {
  const { activeReceiveCount, transfers } = useFileTransferStore.getState();

  // Step 1: 并发接收限制检查
  // 📚 学习要点: 内存保护 — 防止过多并发接收导致 OOM
  // 如果已达到最大并发接收数，静默丢弃新传输的 metadata。
  // 发送方通过 ACK 缺失感知接收方未收到（不主动通知，避免额外消息开销）。
  if (activeReceiveCount >= MAX_CONCURRENT_RECEIVES) {
    console.warn(
      '[FileTransfer/Receiver] 并发接收数已达上限，丢弃传输:',
      data.transferId
    );
    return;
  }

  // Step 1.5: 检查是否已存在相同 transferId 的传输（防止重复处理）
  if (transfers.has(data.transferId)) {
    console.warn(
      '[FileTransfer/Receiver] 传输已存在，忽略重复 metadata:',
      data.transferId
    );
    return;
  }

  // Step 2: 解密 metadata
  // 📚 学习要点: Metadata 的 IV 使用 base64url 编码（与 chunk 的二进制 IV 不同）
  // 因为 metadata 只发送一次，base64url 方便调试和日志记录。
  // 解密流程：base64url → ArrayBuffer → 作为 IV 传给 AES-GCM decrypt
  let metadata: FileMetadata;
  try {
    const ivBuffer = fromBase64Url(data.iv);
    // ivBuffer 已经是 ArrayBuffer，直接用于 AES-GCM 的 iv 参数

    // 📚 学习要点: msgpack 共享缓冲区问题
    // @msgpack/msgpack 解码时使用共享内部缓冲区，data.ciphertext 的 .buffer
    // 可能指向更大的 ArrayBuffer。必须使用 slice() 提取正确的字节范围。
    const ciphertextArr = data.ciphertext instanceof Uint8Array
      ? data.ciphertext
      : new Uint8Array(data.ciphertext as ArrayLike<number>);
    const ciphertextBuffer = ciphertextArr.buffer.slice(
      ciphertextArr.byteOffset,
      ciphertextArr.byteOffset + ciphertextArr.byteLength
    ) as ArrayBuffer;

    // 解密 ciphertext → 明文 JSON bytes
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuffer },
      roomKey,
      ciphertextBuffer
    );

    // 解码 UTF-8 → JSON string → FileMetadata 对象
    const jsonString = new TextDecoder().decode(plaintextBuffer);
    metadata = JSON.parse(jsonString) as FileMetadata;
  } catch (error) {
    console.error(
      '[FileTransfer/Receiver] 元数据解密失败:',
      data.transferId,
      error
    );
    return; // 解密失败，静默丢弃（可能是密钥不匹配或数据损坏）
  }

  // Step 3: 验证 metadata 字段合法性
  // 📚 学习要点: 防御性验证 — 不信任网络数据
  // 即使数据来自加密通道，也需要验证字段合法性：
  // - 恶意发送方可能构造非法 metadata（如 totalChunks=0 或 fileSize=-1）
  // - 加密只保证数据未被第三方篡改，不保证发送方本身是善意的
  if (
    !metadata.transferId ||
    !metadata.fileName ||
    typeof metadata.fileSize !== 'number' ||
    metadata.fileSize <= 0 ||
    metadata.fileSize > MAX_FILE_SIZE ||
    typeof metadata.totalChunks !== 'number' ||
    metadata.totalChunks <= 0 ||
    !metadata.mimeType
  ) {
    console.warn(
      '[FileTransfer/Receiver] 元数据字段验证失败:',
      metadata
    );
    return;
  }

  // Step 4: 创建 TransferState
  const now = Date.now();

  // 📚 学习要点: 缩略图 data URL 转换
  // 如果 metadata 中包含缩略图数据（Uint8Array 格式的 JPEG），
  // 将其转换为 data URL 字符串存储到 TransferState.thumbnail 中。
  // FileMessage 组件可以直接将 data URL 作为 <img> 的 src 使用，
  // 实现在完整文件传输完成前就显示图片预览。
  let thumbnailDataUrl: string | undefined;
  if (metadata.thumbnail && metadata.thumbnail.length > 0) {
    // 📚 学习要点: Uint8Array → data URL 的转换方式
    // 使用 Blob + FileReader 将二进制数据转换为 base64 data URL。
    // 这比手动 btoa() 更可靠，因为 btoa() 对大数据可能有性能问题，
    // 且 FileReader.readAsDataURL() 自动处理 MIME 类型前缀。
    const thumbnailBytes = metadata.thumbnail instanceof Uint8Array
      ? metadata.thumbnail
      : new Uint8Array(Object.values(metadata.thumbnail));
    const blob = new Blob([thumbnailBytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
    const reader = new FileReader();
    thumbnailDataUrl = await new Promise<string>((resolve) => {
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  }

  const transferState: TransferState = {
    transferId: data.transferId,
    direction: 'receive',
    status: 'receiving' as TransferStatus,
    fileName: sanitizeFileName(metadata.fileName),
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    isVoice: metadata.isVoice === true ? true : undefined,
    duration: metadata.isVoice === true ? metadata.duration : undefined,
    totalChunks: metadata.totalChunks,
    receivedChunks: 0,
    lastReceivedIndex: -1,
    chunks: new Array<Uint8Array | null>(metadata.totalChunks).fill(null),
    thumbnail: thumbnailDataUrl,
    startTime: now,
    lastChunkTime: now,
    senderId: data.senderId,
    senderName: data.senderName,
    ackCount: 0,
    totalReceivers: 0,
    chatMessageId: '', // 将在插入聊天消息后更新
  };

  // Step 5: 在聊天列表中插入消息占位符
  // 📚 学习要点: 语音消息 vs 文件消息的分支判断
  // 解密 metadata 后检查 isVoice 字段，决定插入哪种类型的聊天消息占位符：
  // - isVoice === true → 插入 ChatVoiceMessage（subType:'voice'，显示语音气泡）
  // - 否则 → 插入 ChatFileMessage（显示文件卡片，向后兼容）
  // 这是接收端区分语音消息和普通文件的唯一判断点。
  // 后续的 chunk 接收、解密、重组流程完全相同，无需再次判断。
  let chatMessageId: string;
  if (metadata.isVoice === true) {
    chatMessageId = insertReceiverChatVoiceMessage(data, metadata);
  } else {
    chatMessageId = insertReceiverChatFileMessage(data, metadata);
  }
  transferState.chatMessageId = chatMessageId;

  // Step 6: 更新 store 状态（添加传输 + 增加活跃接收计数）
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    newTransfers.set(data.transferId, transferState);
    return {
      transfers: newTransfers,
      activeReceiveCount: state.activeReceiveCount + 1,
    };
  });

  // Step 7: 启动 60s 超时定时器
  startTimeoutTimer(data.transferId);

  // Step 8: 回放在 metadata 解密期间早到的 chunk
  await drainEarlyChunks(data.transferId, roomKey);
}

/**
 * 处理收到的加密文件分片（MSG_RELAY_FILE_CHUNK）。
 *
 * 每收到一个 chunk，执行以下步骤：
 * 1. 验证 transferId 是否存在（丢弃未知传输的 chunk）
 * 2. 验证 index 边界（0 ≤ index < totalChunks）
 * 3. 检查重复（已收到的 chunk 不重复处理）
 * 4. 解密 chunk 数据
 * 5. 存入缓冲区 buffer[index]
 * 6. 检查缓冲区大小限制（累计不超过 5MB）
 * 7. 更新进度（receivedChunks++）
 * 8. 重置超时定时器
 *
 * 📚 学习要点: 为什么需要这么多验证步骤？
 * 接收方不能信任网络数据的任何字段：
 * - transferId 可能是伪造的（指向不存在的传输）
 * - index 可能越界（导致数组越界访问）
 * - 同一 chunk 可能因网络重传被收到多次
 * - 数据可能被篡改（解密会失败）
 * 每一步验证都是一道防线，确保接收引擎的健壮性。
 *
 * @param data - 服务器中转的加密分片数据
 * @param roomKey - 房间 AES-256-GCM 密钥
 *
 * @see requirements.md — Requirements 5.6, 5.7, 5.8, 11.7
 */
export async function handleFileChunk(
  data: RelayFileChunkData,
  roomKey: CryptoKey
): Promise<void> {
  const { transfers } = useFileTransferStore.getState();

  // Step 1: 验证 transferId 存在
  // 📚 学习要点: 静默丢弃未知传输的 chunk
  // 可能的原因：
  // - 接收方因并发限制丢弃了 metadata，但 chunk 仍然到达
  // - 传输已超时/取消/失败，但发送方尚未收到通知
  // - 网络延迟导致 chunk 在 metadata 之前到达（极端情况）
  const transfer = transfers.get(data.transferId);
  if (!transfer) {
    // 可能是 metadata 还在解密（见 bufferEarlyChunk），先暂存等待回放；
    // 若该传输确实不存在，暂存会在 TTL 到期后被清理。
    bufferEarlyChunk(data);
    return;
  }

  // 只处理 'receiving' 状态的传输（其他状态的 chunk 直接丢弃）
  if (transfer.status !== 'receiving') {
    return;
  }

  // Step 2: 验证 index 边界
  // 📚 学习要点: 防止数组越界
  // 恶意发送方可能发送 index=-1 或 index=99999，
  // 如果不验证就直接访问 buffer[index]，会导致 undefined 行为。
  if (data.index < 0 || data.index >= transfer.totalChunks) {
    return; // 静默丢弃越界 chunk
  }

  // Step 3: 检查重复
  // 📚 学习要点: 幂等性保证
  // TCP 保证不重复，但应用层可能因重连或重试导致重复。
  // 如果 buffer[index] 已有数据，说明该 chunk 已处理过，跳过。
  // 这确保了 receivedChunks 计数的准确性。
  if (transfer.chunks[data.index] !== null) {
    return; // 已收到此 chunk，跳过
  }

  // Step 4: 解密 chunk 数据
  // 📚 学习要点: Chunk 的 IV 是原始二进制（Uint8Array），不是 base64url
  // 与 metadata 不同，chunk 是高频消息，使用二进制 IV 避免编解码开销。
  let decryptedData: ArrayBuffer;
  try {
    decryptedData = await decryptChunk(
      roomKey,
      data.iv,
      data.data
    );
  } catch (error) {
    // 解密失败：标记传输为 failed
    // 📚 学习要点: 单个 chunk 解密失败 = 整个传输失败
    // AES-GCM 的认证特性意味着：如果解密失败，数据已被篡改或密钥错误。
    // 无法恢复单个 chunk，因此整个传输必须标记为失败。
    failReceiveTransfer(data.transferId, '文件解密失败，数据可能已损坏');
    return;
  }

  // Step 5: 存入缓冲区
  const chunkData = new Uint8Array(decryptedData);

  // Step 6: 检查缓冲区大小限制
  // 📚 学习要点: 累计大小检查 — 防止内存耗尽
  // 计算当前已接收的总字节数 + 新 chunk 的大小，
  // 如果超过 MAX_BUFFER_SIZE (5MB)，中止传输。
  const currentBufferSize = calculateBufferSize(transfer.chunks);
  if (currentBufferSize + chunkData.byteLength > MAX_BUFFER_SIZE) {
    failReceiveTransfer(data.transferId, '接收数据超过大小限制，传输中止');
    return;
  }

  // Step 7: 更新 store 状态（存入 chunk + 更新进度）
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const currentTransfer = newTransfers.get(data.transferId);
    if (!currentTransfer || currentTransfer.status !== 'receiving') {
      return { transfers: newTransfers };
    }

    // 创建新的 chunks 数组（不可变更新）
    const newChunks = [...currentTransfer.chunks];
    newChunks[data.index] = chunkData;

    newTransfers.set(data.transferId, {
      ...currentTransfer,
      chunks: newChunks,
      receivedChunks: currentTransfer.receivedChunks + 1,
      lastReceivedIndex: data.index,
      lastChunkTime: Date.now(),
    });

    return { transfers: newTransfers };
  });

  // Step 8: 重置超时定时器
  // 📚 学习要点: 每收到一个 chunk 就重置超时
  // 只要数据持续到达，传输就不会超时。
  // 超时只在"完全没有新数据"时触发（网络断开或发送方崩溃）。
  resetTimeoutTimer(data.transferId);

  // Step 9: 若 COMPLETE 已先行到达，此刻补齐最后一个 chunk，由这里收尾
  // 见 handleFileComplete：COMPLETE 与 chunk 解密在事件循环中竞争，
  // 谁最后到达谁负责收尾。
  const updated = useFileTransferStore.getState().transfers.get(data.transferId);
  if (
    updated?.completionSignaled === true &&
    updated.status === 'receiving' &&
    updated.receivedChunks === updated.totalChunks
  ) {
    finalizeReceive(data.transferId);
  }
}

/**
 * 处理传输完成信号（MSG_RELAY_FILE_COMPLETE）。
 *
 * 接收方收到此信号后执行以下步骤：
 * 1. 验证 transferId 存在且状态为 'receiving'
 * 2. 验证所有 chunk 已收齐（receivedChunks === totalChunks）
 * 3. 重组文件：reassembleChunks() → Blob
 * 4. 清理文件名：sanitizeFileName()
 * 5. 创建 Blob URL：URL.createObjectURL()
 * 6. 发送 ACK：MSG_SEND_FILE_ACK
 * 7. 更新状态为 'complete'，释放 chunk 缓冲区
 * 8. 清除超时定时器
 *
 * 📚 学习要点: 为什么需要 COMPLETE 信号？
 * TCP 保证消息顺序，但接收方无法仅通过 chunk 数量判断传输是否完成：
 * - 如果最后一个 chunk 丢失（服务器端超时），接收方不知道还有没有更多 chunk
 * - COMPLETE 信号是发送方的明确声明："我已发送完所有 chunk"
 * - 接收方收到 COMPLETE 后验证 chunk 数量，确保数据完整性
 *
 * @param data - 服务器中转的完成信号
 *
 * @see requirements.md — Requirements 5.9, 7.3, 7.7
 */
export function handleFileComplete(data: RelayFileCompleteData): void {
  const { transfers } = useFileTransferStore.getState();
  const transfer = transfers.get(data.transferId);

  // 验证传输存在且状态正确
  if (!transfer || transfer.status !== 'receiving') {
    return;
  }

  // 📚 学习要点: COMPLETE 早于 chunk 处理完成是正常现象，不是数据丢失
  // chunk 的处理链路是异步的（await decryptChunk → crypto.subtle.decrypt），
  // 而 COMPLETE 紧跟在最后一个 chunk 之后到达。两者在事件循环里竞争，
  // COMPLETE 往往先跑完 —— 对只有一个 chunk 的语音消息几乎必然如此。
  //
  // 过去这里直接判定「文件不完整」，把一个正常的时序当成了丢包，表现为
  // 「已收到 0/1 个分片」。正确做法是记下「发送方已声明发完」，等最后一个
  // chunk 落盘后再收尾；真正缺失的 chunk 由 60s 超时兜底。
  if (transfer.receivedChunks !== transfer.totalChunks) {
    markCompletionSignaled(data.transferId);
    return;
  }

  finalizeReceive(data.transferId);
}

/** 记录发送方已发出 COMPLETE，但仍有 chunk 在异步处理中。 */
function markCompletionSignaled(transferId: string): void {
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const transfer = newTransfers.get(transferId);
    if (transfer && transfer.status === 'receiving') {
      newTransfers.set(transferId, { ...transfer, completionSignaled: true });
    }
    return { transfers: newTransfers };
  });
}

/**
 * 收尾：重组文件、回 ACK、更新状态为 complete、触发语音回调。
 *
 * 两个调用点：COMPLETE 到达且 chunk 已齐，或最后一个 chunk 落盘时发现
 * COMPLETE 已经先到过。
 */
function finalizeReceive(transferId: string): void {
  const transfer = useFileTransferStore.getState().transfers.get(transferId);
  if (!transfer || transfer.status !== 'receiving') {
    return;
  }

  // 重组文件
  const blob = reassembleChunks(transfer.chunks, transfer.mimeType);
  const blobUrl = URL.createObjectURL(blob);

  // 发送 ACK 确认
  const ackData: SendFileAckData = { transferId: transferId };
  send(MSG_SEND_FILE_ACK, ackData);

  // 更新状态为 complete，释放 chunk 缓冲区
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const currentTransfer = newTransfers.get(transferId);
    if (currentTransfer) {
      newTransfers.set(transferId, {
        ...currentTransfer,
        status: 'complete' as TransferStatus,
        blobUrl,
        chunks: [], // 释放缓冲区内存（Blob 已持有数据引用）
      });
    }
    return {
      transfers: newTransfers,
      activeReceiveCount: Math.max(0, state.activeReceiveCount - 1),
    };
  });

  // 📚 学习要点: 语音传输完成回调触发
  // 如果此传输是语音消息（isVoice === true），通知已注册的回调。
  // 回调由 voiceStore 注册，用于将 blobUrl 存入语音 Blob 缓存（LRU）。
  // 为什么在 setState 之后调用？
  // - 确保 TransferState 已更新为 'complete'（状态一致性）
  // - 回调中可能读取 store 状态，此时状态已是最新的
  // - 即使回调抛出异常，传输状态已正确更新（不影响核心流程）
  if (transfer.isVoice === true) {
    const { onTransferComplete } = useFileTransferStore.getState();
    if (onTransferComplete) {
      // 📚 学习要点: 从 TransferState 重构 FileMetadata 传递给回调
      // handleFileMeta 解密 metadata 时已将关键字段缓存到 TransferState，
      // 此处重构 FileMetadata 对象供 voiceStore 使用（包含 isVoice 和 duration）。
      const reconstructedMetadata: FileMetadata = {
        transferId: transfer.transferId,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        mimeType: transfer.mimeType,
        totalChunks: transfer.totalChunks,
        isVoice: true,
        duration: transfer.duration,
      };
      try {
        onTransferComplete(transferId, blobUrl, reconstructedMetadata);
      } catch (error) {
        // 📚 学习要点: 回调异常隔离
        // 回调中的异常不应影响文件传输核心流程。
        // 使用 try/catch 隔离，仅打印警告日志。
        // 即使 voiceStore 出错，文件传输的状态更新和 ACK 发送已完成。
        console.warn(
          '[FileTransfer/Receiver] onTransferComplete 回调异常:',
          transferId,
          error
        );
      }
    }
  }

  // 清除超时定时器
  clearTimeoutTimer(transferId);
}

/**
 * 处理传输取消信号（MSG_RELAY_FILE_CANCEL）。
 *
 * 发送方主动取消传输时，接收方收到此信号后：
 * 1. 释放 chunk 缓冲区
 * 2. 更新状态为 'cancelled'，显示"发送方已取消传输"
 * 3. 清除超时定时器
 * 4. 减少活跃接收计数
 *
 * @param data - 服务器中转的取消信号
 *
 * @see requirements.md — Requirements 6.3, 6.4
 */
export function handleFileCancel(data: RelayFileCancelData): void {
  const { transfers } = useFileTransferStore.getState();
  const transfer = transfers.get(data.transferId);

  // 验证传输存在且为接收中状态
  if (!transfer || transfer.direction !== 'receive') {
    return;
  }

  // 只处理非终态的传输
  if (
    transfer.status === 'complete' ||
    transfer.status === 'failed' ||
    transfer.status === 'cancelled'
  ) {
    return;
  }

  // 更新状态为 cancelled，释放缓冲区
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const currentTransfer = newTransfers.get(data.transferId);
    if (currentTransfer) {
      newTransfers.set(data.transferId, {
        ...currentTransfer,
        status: 'cancelled' as TransferStatus,
        error: '发送方已取消传输',
        chunks: [], // 释放缓冲区内存
      });
    }
    return {
      transfers: newTransfers,
      activeReceiveCount: Math.max(0, state.activeReceiveCount - 1),
    };
  });

  // 清除超时定时器
  clearTimeoutTimer(data.transferId);
}

/**
 * 处理发送方离开房间的情况。
 *
 * 当发送方离开房间时，其所有正在进行的接收传输都无法继续。
 * 此方法查找所有来自该发送方的活跃接收传输，标记为 failed。
 *
 * 📚 学习要点: 为什么需要单独的 handleSenderLeft？
 * 服务器会在发送方断线时广播 MSG_RELAY_FILE_CANCEL，
 * 但 MEMBER_LEFT 事件可能先于 CANCEL 到达（消息顺序不保证跨类型）。
 * 主动处理 MEMBER_LEFT 提供更快的 UI 反馈：
 * - 用户立即看到"发送方已离开，传输中断"
 * - 不需要等待 60s 超时
 * - 即使 CANCEL 消息丢失，传输也能正确终止
 *
 * @param senderId - 离开的发送方客户端 ID
 *
 * @see requirements.md — Requirement 6.5
 */
export function handleSenderLeft(senderId: string): void {
  const { transfers } = useFileTransferStore.getState();
  const affectedTransferIds: string[] = [];

  // 查找所有来自该发送方的活跃接收传输
  for (const [transferId, transfer] of transfers) {
    if (
      transfer.senderId === senderId &&
      transfer.direction === 'receive' &&
      (transfer.status === 'receiving' || transfer.status === 'pending')
    ) {
      affectedTransferIds.push(transferId);
    }
  }

  if (affectedTransferIds.length === 0) {
    return;
  }

  // 批量更新所有受影响的传输
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    let receiveCountDelta = 0;

    for (const transferId of affectedTransferIds) {
      const transfer = newTransfers.get(transferId);
      if (transfer) {
        newTransfers.set(transferId, {
          ...transfer,
          status: 'failed' as TransferStatus,
          error: '发送方已离开，传输中断',
          chunks: [], // 释放缓冲区内存
        });
        receiveCountDelta++;
      }
    }

    return {
      transfers: newTransfers,
      activeReceiveCount: Math.max(0, state.activeReceiveCount - receiveCountDelta),
    };
  });

  // 清除所有受影响传输的超时定时器
  for (const transferId of affectedTransferIds) {
    clearTimeoutTimer(transferId);
  }
}


// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 在聊天列表中插入接收方的文件消息占位符。
 *
 * 📚 学习要点: 接收方占位符 vs 发送方占位符
 * - 发送方占位符：isMine=true，在 sendFile() 开始时插入
 * - 接收方占位符：isMine=false，在收到 metadata 时插入
 * 两者结构相同（ChatFileMessage），但 isMine 字段决定了 UI 渲染位置（左/右对齐）。
 *
 * @param data - 中转的元数据消息（包含 senderId、senderName、时间戳）
 * @param metadata - 解密后的文件元数据
 * @returns 生成的聊天消息 ID
 */
function insertReceiverChatFileMessage(
  data: RelayFileMetaData,
  metadata: FileMetadata
): string {
  const timestamp = data.t || Date.now();
  const chatMessageId = generateChatMessageId('file');

  const fileMessage: ChatFileMessage = {
    id: chatMessageId,
    stableId: `${data.senderId}-${timestamp}`,
    senderId: data.senderId,
    senderName: data.senderName,
    text: '',  // 文件消息不使用 text 字段
    timestamp,
    isMine: false,  // 接收方：消息来自他人
    isSystem: false,
    type: 'file',
    transferId: data.transferId,
    fileName: sanitizeFileName(metadata.fileName),
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
  };

  // 插入到 chatStore 的 messages 数组中
  useChatStore.setState((state) => {
    const messages = [
      ...state.messages,
      fileMessage as unknown as typeof state.messages[0],
    ];
    return {
      messages: messages.length > 200 ? messages.slice(-200) : messages,
    };
  });

  return chatMessageId;
}

/**
 * 在聊天列表中插入接收方的语音消息占位符。
 *
 * 📚 学习要点: 语音消息占位符 vs 文件消息占位符
 * 语音消息使用 ChatVoiceMessage 类型（继承 ChatFileMessage），额外包含：
 * - subType: 'voice' — 让 MessageList.tsx 渲染语音气泡而非文件卡片
 * - duration — 语音时长（秒），用于 UI 显示 "0:05" 格式
 *
 * 📚 学习要点: receiver.ts 不直接 import voiceStore — 通过回调模式解耦
 * 此函数仅负责在 chatStore 中插入消息占位符（纯数据操作）。
 * 语音 Blob 的缓存管理由 voiceStore 通过 onTransferComplete 回调处理。
 * 这避免了 file-transfer ↔ voice 的循环依赖：
 * - file-transfer/receiver.ts → chatStore（单向，已有依赖）
 * - voiceStore → fileTransferStore（通过 registerTransferCompleteCallback 注册回调）
 * - fileTransferStore → voiceStore（通过回调调用，无 import 依赖）
 *
 * @param data - 中转的元数据消息（包含 senderId、senderName、时间戳）
 * @param metadata - 解密后的文件元数据（包含 isVoice、duration）
 * @returns 生成的聊天消息 ID
 */
function insertReceiverChatVoiceMessage(
  data: RelayFileMetaData,
  metadata: FileMetadata
): string {
  const timestamp = data.t || Date.now();
  const chatMessageId = generateChatMessageId('voice');

  // 📚 学习要点: ChatVoiceMessage 的构造
  // 继承 ChatFileMessage 的所有字段（type:'file', transferId, fileName 等），
  // 额外添加 subType:'voice' 和 duration。
  // MessageList.tsx 通过 isVoiceMessage() 类型守卫检查 subType 字段，
  // 决定渲染 <VoiceMessage /> 还是 <FileMessage />。
  const voiceMessage: ChatVoiceMessage = {
    id: chatMessageId,
    stableId: `${data.senderId}-${timestamp}`,
    senderId: data.senderId,
    senderName: data.senderName,
    text: '',  // 语音消息不使用 text 字段
    timestamp,
    isMine: false,  // 接收方：消息来自他人
    isSystem: false,
    type: 'file',  // 保持 type:'file' 以兼容现有消息列表逻辑
    transferId: data.transferId,
    fileName: sanitizeFileName(metadata.fileName),
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    subType: 'voice',
    duration: metadata.duration ?? 0,
  };

  // 插入到 chatStore 的 messages 数组中
  useChatStore.setState((state) => {
    const messages = [
      ...state.messages,
      voiceMessage as unknown as typeof state.messages[0],
    ];
    return {
      messages: messages.length > 200 ? messages.slice(-200) : messages,
    };
  });

  return chatMessageId;
}

/**
 * 启动接收超时定时器。
 *
 * 📚 学习要点: 超时定时器的作用
 * 如果 60 秒内没有收到任何新 chunk，认为传输已失败：
 * - 发送方可能崩溃（但 TCP 连接未断开）
 * - 网络中间设备可能丢弃了后续数据包
 * - 服务器可能因内部错误停止转发
 *
 * 超时后释放缓冲区内存，防止"僵尸传输"长期占用资源。
 *
 * @param transferId - 传输 ID
 */
function startTimeoutTimer(transferId: string): void {
  // 清除可能存在的旧定时器（防御性编程）
  clearTimeoutTimer(transferId);

  const timer = setTimeout(() => {
    // 超时触发：标记传输为失败
    failReceiveTransfer(transferId, '传输超时');
    timeoutTimers.delete(transferId);
  }, RECEIVE_TIMEOUT_MS);

  timeoutTimers.set(transferId, timer);
}

/**
 * 重置接收超时定时器（收到新 chunk 时调用）。
 *
 * 📚 学习要点: 为什么重置而非累加？
 * 超时的含义是"最后一次数据到达后的等待时间"，而非"传输总时间"。
 * 一个 5MB 文件的正常传输可能需要 10-30 秒（取决于网络），
 * 如果使用总时间超时，正常传输也会被误判为超时。
 * 重置策略确保：只要数据持续到达，传输就不会超时。
 *
 * @param transferId - 传输 ID
 */
function resetTimeoutTimer(transferId: string): void {
  startTimeoutTimer(transferId); // startTimeoutTimer 内部会先清除旧定时器
}

/**
 * 清除超时定时器（传输完成/取消/失败时调用）。
 *
 * @param transferId - 传输 ID
 */
function clearTimeoutTimer(transferId: string): void {
  const timer = timeoutTimers.get(transferId);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(transferId);
  }
}

/**
 * 标记接收传输为失败状态，释放资源。
 *
 * 📚 学习要点: 接收失败的资源清理
 * 失败时需要释放以下资源：
 * 1. Chunk 缓冲区：设为空数组，让 GC 回收（可能高达 5MB）
 * 2. 超时定时器：clearTimeout 防止后续误触发
 * 3. 活跃接收计数：减 1，允许新的传输进入
 *
 * 不释放 chatStore 中的占位符消息（保留在聊天流中显示错误状态）。
 *
 * @param transferId - 传输 ID
 * @param error - 错误描述信息
 */
function failReceiveTransfer(transferId: string, error: string): void {
  // 📚 学习要点: 失败原因必须可见
  // 本函数有四个调用点（解密失败、超限、分片不全、超时），但 UI 把它们
  // 统一显示成一句「解密失败」。原因只写进 transfer.error，不打日志的话，
  // 线上排查时四种完全不同的故障看起来一模一样。
  console.error('[FileTransfer/Receiver] transfer failed:', transferId, error);

  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const transfer = newTransfers.get(transferId);

    if (!transfer || transfer.direction !== 'receive') {
      return { transfers: newTransfers };
    }

    // 只处理非终态的传输
    if (
      transfer.status === 'complete' ||
      transfer.status === 'failed' ||
      transfer.status === 'cancelled'
    ) {
      return { transfers: newTransfers };
    }

    newTransfers.set(transferId, {
      ...transfer,
      status: 'failed' as TransferStatus,
      error,
      chunks: [], // 释放缓冲区内存
    });

    return {
      transfers: newTransfers,
      activeReceiveCount: Math.max(0, state.activeReceiveCount - 1),
    };
  });

  // 清除超时定时器
  clearTimeoutTimer(transferId);
}

/**
 * 计算 chunk 缓冲区当前已占用的字节数。
 *
 * 📚 学习要点: 为什么需要动态计算而非使用 fileSize？
 * metadata 中的 fileSize 是发送方声称的大小，不可完全信任。
 * 实际计算已接收的字节数更准确，且能检测到异常情况
 * （如发送方发送了超过声称大小的数据）。
 *
 * @param chunks - 当前的 chunk 缓冲区
 * @returns 已占用的总字节数
 */
function calculateBufferSize(chunks: (Uint8Array | null)[]): number {
  let totalSize = 0;
  for (const chunk of chunks) {
    if (chunk !== null) {
      totalSize += chunk.byteLength;
    }
  }
  return totalSize;
}
