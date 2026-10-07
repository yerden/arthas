/**
 * @file fileTransferStore.ts — 文件传输状态管理（Zustand Store）
 *
 * 本文件是文件传输模块的「大脑」，负责管理所有传输的生命周期状态。
 * 它是 UI 组件和传输引擎之间的桥梁：
 * - UI 组件通过订阅 store 获取实时传输状态（进度、速度、错误）
 * - 传输引擎（sender.ts / receiver.ts）通过 store actions 更新状态
 * - chatStore 通过 handleFileMessage() 将文件传输消息路由到此 store
 *
 * 📚 学习要点: 为什么文件传输状态独立于 chatStore？
 * 1. 关注点分离：chatStore 管理聊天消息流，fileTransferStore 管理传输生命周期
 * 2. 内存隔离：传输状态包含大量临时数据（chunk 缓冲区），不应与消息数组混合
 * 3. 生命周期独立：消息数组有 MAX_MESSAGES=200 限制，传输状态不应被溢出淘汰
 * 4. 性能优化：UI 组件可以精确订阅单个传输的状态变化，避免不必要的重渲染
 *
 * 📚 学习要点: 状态机设计（State Machine Design）
 * 每个传输都是一个独立的有限状态机（FSM），有明确的状态转换规则：
 * - pending → sending | receiving | cancelled | failed
 * - sending → complete | failed | cancelled
 * - receiving → complete | failed | cancelled
 * - complete / failed / cancelled → 终态（不可转换）
 *
 * 使用 Map<transferId, TransferState> 存储所有传输状态，
 * 每个传输通过 transferId 独立追踪，互不干扰。
 * 这种设计确保了：
 * - 并发接收多个文件时，各传输状态互不影响
 * - 单个传输失败不会影响其他传输
 * - 状态转换有明确的规则，防止非法状态
 *
 * @module file-transfer/fileTransferStore
 * @see design.md — 文件传输 Store 设计
 * @see requirements.md — Requirements 3.7, 5.8, 11.3, 11.4, 5.6, 5.11
 */

import { create } from 'zustand';
import {
  MSG_RELAY_FILE_META,
  MSG_RELAY_FILE_CHUNK,
  MSG_RELAY_FILE_COMPLETE,
  MSG_RELAY_FILE_CANCEL,
  MSG_RELAY_FILE_ACK,
  MSG_SEND_FILE_CANCEL,
  type Message,
  type SendFileCancelData,
} from '../network/protocol';
import { send, isConnected } from '../network/websocket';
import {
  type TransferState,
  type FileTransferState,
  type TransferStatus,
  type FileMetadata,
  type TransferInitiateOptions,
  MAX_FILE_SIZE,
  CHUNK_SIZE,
  generateTransferId,
} from './types';
import { storeFileRef, sendFile, removeFileRef } from './sender';
import {
  handleFileMeta,
  handleFileChunk,
  handleFileComplete,
  handleFileCancel,
  handleSenderLeft as receiverHandleSenderLeft,
} from './receiver';
import { useChatStore } from '../stores/chatStore';
import { useI18nStore } from '../i18n/store';
import { translate } from '../i18n/translate';

// ============================================================================
// 模块级状态：extraMetadata 存储
// ============================================================================

/**
 * 额外元数据映射：transferId → extraMetadata 对象。
 *
 * 📚 学习要点: 为什么使用模块级 Map 存储 extraMetadata？
 * 与 sender.ts 中的 fileRefs Map 采用相同的设计模式：
 *
 * 1. Zustand state 应保持可序列化（JSON-like），extraMetadata 中可能包含
 *    不可序列化的值（虽然当前只有 { isVoice: true, duration: number }，
 *    但接口设计为 Record<string, unknown> 以保持扩展性）
 * 2. extraMetadata 是传输过程中的临时数据，不需要触发 React 重渲染
 * 3. 生命周期与传输一致：processQueue 触发 sendFile 时读取，传输完成后清理
 * 4. 与 storeFileRef 模式一致，降低认知负担（同一模块中的相似问题用相似方案解决）
 *
 * 数据流：
 * initiateTransfer(file, { extraMetadata }) → extraMetadataRefs.set(transferId, extraMetadata)
 * processQueue() → sendFile() → sendEncryptedMetadata(transferId, file, roomKey, extraMetadata)
 * sendEncryptedMetadata 将 extraMetadata 合并到 FileMetadata 对象中一起加密
 *
 * @see sender.ts — fileRefs Map（相同的模块级存储模式）
 * @see design.md — 语音消息通过 extraMetadata 注入 isVoice 和 duration
 */
const extraMetadataRefs = new Map<string, Record<string, unknown>>();

/**
 * 存储额外元数据，供后续 sendFile() 中的 sendEncryptedMetadata() 使用。
 *
 * @param transferId - 传输唯一标识符
 * @param metadata - 要合并到 FileMetadata 中的额外字段
 */
export function storeExtraMetadata(transferId: string, metadata: Record<string, unknown>): void {
  extraMetadataRefs.set(transferId, metadata);
}

/**
 * 获取并移除额外元数据（一次性读取，读取后自动清理）。
 *
 * 📚 学习要点: 为什么使用"获取并移除"模式？
 * extraMetadata 只在 sendEncryptedMetadata() 中使用一次（合并到加密 payload 中）。
 * 使用后立即从 Map 中移除，防止内存泄漏。
 * 如果传输失败或被取消，cleanupExtraMetadata() 会兜底清理。
 *
 * @param transferId - 传输唯一标识符
 * @returns 额外元数据对象，如果不存在则返回 undefined
 */
export function consumeExtraMetadata(transferId: string): Record<string, unknown> | undefined {
  const metadata = extraMetadataRefs.get(transferId);
  if (metadata) {
    extraMetadataRefs.delete(transferId);
  }
  return metadata;
}

/**
 * 清理额外元数据（传输失败/取消时的兜底清理）。
 *
 * @param transferId - 传输唯一标识符
 */
export function cleanupExtraMetadata(transferId: string): void {
  extraMetadataRefs.delete(transferId);
}

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 发送队列最大容量：3 个待发送传输。
 *
 * 📚 学习要点: 为什么限制队列大小？
 * - 防止用户无限制地添加文件到队列，导致 UI 混乱
 * - 每个待发送传输都占用一定内存（File 引用、metadata 等）
 * - 3 个队列 + 1 个活跃 = 最多 4 个发送方传输同时存在
 * - 超过限制时给用户明确反馈："队列已满，请稍后再试"
 *
 * @see requirements.md — Requirement 11.4
 */
const MAX_SEND_QUEUE_SIZE = 3;

/**
 * 最大并发接收传输数：5 个。
 *
 * 📚 学习要点: 内存保护策略
 * 如果 10 个发送方同时发送 5MB 文件，接收方需要 50MB 缓冲区。
 * 在移动设备或低内存环境下，这可能导致页面崩溃（OOM）。
 * 因此限制最大并发接收数为 5 个：
 * - 最坏情况内存占用：5 × 5MB = 25MB（可接受）
 * - 超过限制时静默丢弃新传输的 metadata（不通知发送方）
 * - 发送方通过 ACK 缺失感知接收方未收到
 *
 * @see design.md — 并发接收限制
 */
const MAX_CONCURRENT_RECEIVES = 5;

// ============================================================================
// Store Actions 接口定义
// ============================================================================

/**
 * 文件传输 Store 的所有可用操作。
 *
 * 📚 学习要点: 接口与实现分离
 * 将 actions 定义为接口的一部分，让 TypeScript 编译器确保所有操作都被实现。
 * 这也为 UI 组件提供了清晰的 API 文档——组件只需要知道有哪些操作可用，
 * 不需要了解内部实现细节。
 */
interface FileTransferActions {
  /**
   * 统一处理所有文件传输相关的服务器消息。
   * 由 chatStore.handleServerMessage 调用，将文件传输消息路由到对应的内部处理器。
   *
   * @param msg - 服务器消息（type 为 MSG_RELAY_FILE_* 之一）
   */
  handleFileMessage: (msg: Message) => void;

  /**
   * 发起文件传输：验证文件 → 创建传输状态 → 加入发送队列。
   * 实际的发送逻辑（加密、WebSocket 发送）由 sender.ts 在 processQueue 触发时执行。
   *
   * 📚 学习要点: 可选 options 参数的扩展点设计
   * 第二个参数 options 是可选的，包含 extraMetadata 字段。
   * 语音模块通过此参数注入 { isVoice: true, duration } 到加密 metadata 中，
   * 而无需修改 initiateTransfer 的核心逻辑（队列管理、互斥检查、状态追踪）。
   * 现有的 initiateTransfer(file) 调用完全不受影响（向后兼容）。
   *
   * @param file - 用户选择的文件对象
   * @param options - 可选配置，包含要合并到加密 metadata 中的额外字段
   * @returns 生成的 transferId（用于 UI 关联），如果验证失败返回 null
   */
  initiateTransfer: (file: File, options?: TransferInitiateOptions) => string | null;

  /**
   * 取消传输：更新状态为 cancelled，如果是活跃发送则停止，如果在队列中则移除。
   *
   * @param transferId - 要取消的传输 ID
   */
  cancelTransfer: (transferId: string) => void;

  /**
   * 清理已完成/失败/取消的传输：从 Map 中移除，释放 Blob URL 等资源。
   * 通常在消息气泡被移除时调用（ephemeral 模式或 MAX_MESSAGES 溢出）。
   *
   * @param transferId - 要清理的传输 ID
   */
  cleanupTransfer: (transferId: string) => void;

  /**
   * 中止所有活跃传输：将所有非终态传输标记为 failed，释放缓冲区。
   * 在房间关闭或用户离开房间时调用。
   *
   * @see requirements.md — Requirement 6.6
   */
  abortAllTransfers: () => void;

  /**
   * 处理发送方离开房间：将该发送方的所有接收中传输标记为 failed。
   * 由 chatStore 在 MSG_MEMBER_LEFT 时调用。
   *
   * @param senderId - 离开的发送方客户端 ID
   * @see requirements.md — Requirement 6.5
   */
  handleSenderLeft: (senderId: string) => void;

  /**
   * 注册语音传输完成回调。
   *
   * 📚 学习要点: 回调注册模式（Callback Registration Pattern）
   * voiceStore 在初始化时调用此方法注册回调函数。
   * 当 receiver.ts 的 handleFileComplete 检测到 isVoice === true 时，
   * 会调用已注册的回调，将 transferId、blobUrl 和 metadata 传递给 voiceStore。
   *
   * 这种模式的优势：
   * 1. 避免 file-transfer → voice 的循环依赖
   * 2. file-transfer 模块不需要知道 voice 模块的存在（松耦合）
   * 3. 回调可以在运行时动态注册/注销（灵活性）
   * 4. 如果 voice 模块未加载，回调为 undefined，不影响文件传输正常工作
   *
   * @param cb - 传输完成时的回调函数，接收 transferId、blobUrl 和解密后的 metadata
   */
  registerTransferCompleteCallback: (
    cb: (transferId: string, blobUrl: string, metadata: FileMetadata) => void
  ) => void;

  /**
   * 注销语音传输完成回调。
   *
   * 在 voiceStore cleanup（用户离开房间）时调用，防止回调引用过期的 store 实例。
   *
   * 📚 学习要点: 为什么需要注销？
   * 如果用户离开房间后 voiceStore 被重置，但回调仍然指向旧的 store 方法，
   * 后续的 handleFileComplete 调用会触发已失效的回调，可能导致：
   * - 操作已清空的 Map（无害但浪费）
   * - 引用已 revoke 的 Blob URL（导致播放失败）
   * 注销回调确保生命周期一致性。
   */
  unregisterTransferCompleteCallback: () => void;
}

// ============================================================================
// Store 创建
// ============================================================================

/**
 * 文件传输 Zustand Store。
 *
 * 📚 学习要点: Zustand Store 模式
 * Zustand 使用 `create` 函数创建 store，接受一个 `(set, get) => state & actions` 的工厂函数。
 * - `set`: 更新状态（浅合并，类似 React 的 setState）
 * - `get`: 获取当前状态快照（用于 actions 中读取最新状态）
 *
 * 与 Redux 的区别：
 * - 无需 reducers、action creators、dispatch
 * - Actions 直接定义在 store 中，可以是异步的
 * - 组件通过 selector 订阅部分状态，自动优化重渲染
 *
 * 使用方式：
 * ```typescript
 * // 在组件中订阅特定传输的状态
 * const transfer = useFileTransferStore(state => state.transfers.get(transferId));
 *
 * // 在非组件代码中直接访问
 * const { initiateTransfer } = useFileTransferStore.getState();
 * ```
 */
export const useFileTransferStore = create<FileTransferState & FileTransferActions>(
  (set, get) => ({
    // ========================================================================
    // 初始状态
    // ========================================================================

    /** 所有传输状态的映射：transferId → TransferState */
    transfers: new Map<string, TransferState>(),

    /** 待发送队列（FIFO），存储 transferId，最多 MAX_SEND_QUEUE_SIZE 个 */
    sendQueue: [],

    /** 当前活跃发送的 transferId（同一时间只有一个） */
    activeSendId: null,

    /** 当前活跃接收传输数（限制最大 MAX_CONCURRENT_RECEIVES 个） */
    activeReceiveCount: 0,

    /**
     * 语音传输完成回调（初始为 undefined）。
     *
     * 📚 学习要点: 可选回调的初始值
     * 初始为 undefined，表示没有模块注册回调。
     * 当 voiceStore 初始化时会调用 registerTransferCompleteCallback 注册回调。
     * receiver.ts 在调用前会检查 `if (callback)` 确保安全。
     */
    onTransferComplete: undefined,

    // ========================================================================
    // Actions
    // ========================================================================

    handleFileMessage: (msg: Message) => {
      /**
       * 📚 学习要点: 消息分发器模式（Message Dispatcher Pattern）
       * 此方法是文件传输消息的统一入口点。
       * chatStore 收到文件传输相关的服务器消息后，调用此方法进行二次路由。
       *
       * 为什么不在 chatStore 中直接处理？
       * 1. 单一职责：chatStore 负责聊天，fileTransferStore 负责文件传输
       * 2. 代码组织：文件传输逻辑集中在 file-transfer/ 目录下
       * 3. 可测试性：可以独立测试文件传输消息处理逻辑
       *
       * 消息路由到 receiver.ts 的对应方法：
       * - META → handleFileMeta(): 解密 metadata → 准备接收缓冲区 → 插入聊天占位符
       * - CHUNK → handleFileChunk(): 验证 → 解密 → 存入缓冲区 → 更新进度
       * - COMPLETE → handleFileComplete(): 验证完整性 → 重组文件 → 发送 ACK
       * - CANCEL → handleFileCancel(): 释放缓冲区 → 显示取消信息
       * - ACK → 更新发送方的 ackCount（已送达计数）
       */

      // 获取房间密钥（接收方解密需要）
      // 📚 学习要点: 跨 Store 数据获取
      // roomKey 存储在 chatStore 中，fileTransferStore 通过 .getState() 获取。
      // 这是 Zustand 的优势：无需 Provider 嵌套或 context 传递。
      const { roomKey } = useChatStore.getState();

      switch (msg.type) {
        case MSG_RELAY_FILE_META: {
          // 解密 metadata → 准备接收缓冲区 → 插入聊天占位符 → 启动超时
          if (!roomKey) {
            console.warn('[FileTransfer] No room key, cannot process file metadata');
            break;
          }
          const metaData = msg.data as import('../network/protocol').RelayFileMetaData;
          handleFileMeta(metaData, roomKey);
          break;
        }

        case MSG_RELAY_FILE_CHUNK: {
          // 验证 transferId → 解密 chunk → 存入缓冲区 → 更新进度 → 重置超时
          if (!roomKey) break;
          const chunkData = msg.data as import('../network/protocol').RelayFileChunkData;
          handleFileChunk(chunkData, roomKey);
          break;
        }

        case MSG_RELAY_FILE_COMPLETE: {
          // 验证所有 chunk 已收齐 → 重组文件 → 创建 Blob URL → 发送 ACK
          const completeData = msg.data as import('../network/protocol').RelayFileCompleteData;
          handleFileComplete(completeData);
          break;
        }

        case MSG_RELAY_FILE_CANCEL: {
          // 释放缓冲区 → 显示"发送方已取消传输"
          const cancelData = msg.data as import('../network/protocol').RelayFileCancelData;
          handleFileCancel(cancelData);
          break;
        }

        case MSG_RELAY_FILE_ACK: {
          // 处理接收确认：更新发送方的 ackCount
          // 📚 学习要点: ACK 只影响发送方的状态
          // 接收方发送 ACK 后，服务器将其中转给原始发送方。
          // 发送方收到 ACK 后更新"已送达 (N/M)"计数。
          const ackData = msg.data as import('../network/protocol').RelayFileAckData;
          const { transfers } = get();
          const transfer = transfers.get(ackData.transferId);
          if (transfer && transfer.direction === 'send') {
            set((state) => {
              const newTransfers = new Map(state.transfers);
              const t = newTransfers.get(ackData.transferId);
              if (t) {
                newTransfers.set(ackData.transferId, {
                  ...t,
                  ackCount: t.ackCount + 1,
                });
              }
              return { transfers: newTransfers };
            });
          }
          break;
        }

        default: {
          // 📚 学习要点: Exhaustive Check 的防御性编程
          // 如果未来新增了文件传输消息类型但忘记在此处理，
          // 这个 default 分支会在开发时通过 console.warn 提醒开发者。
          console.warn('[FileTransfer] Unknown file message type:', msg.type);
        }
      }
    },

    initiateTransfer: (file: File, options?: TransferInitiateOptions): string | null => {
      /**
       * 📚 学习要点: 发起传输的完整流程
       * 1. 验证文件大小（≤ 5MB）
       * 2. 检查队列容量（≤ 3 个待发送）
       * 3. 生成唯一 transferId
       * 4. 创建 TransferState（status: 'pending'）
       * 5. 存储 extraMetadata（如果提供）
       * 6. 加入发送队列
       * 7. 触发队列处理（如果当前无活跃发送）
       *
       * 📚 学习要点: extraMetadata 的传递路径
       * initiateTransfer(file, { extraMetadata: { isVoice: true, duration: 5 } })
       *   → extraMetadataRefs.set(transferId, extraMetadata)  // 模块级 Map 存储
       *   → processQueue() 触发 sendFile(transferId, roomKey)
       *   → sendFile 内部调用 sendEncryptedMetadata(transferId, file, roomKey)
       *   → sendEncryptedMetadata 通过 consumeExtraMetadata(transferId) 获取并合并到 FileMetadata
       *   → 合并后的 metadata 被 JSON 序列化 → AES-GCM 加密 → 发送
       *
       * 注意：此方法只负责状态管理，不执行实际的文件发送。
       * 实际发送由 processQueue() 触发，sender.ts 执行。
       */

      // Step 1: 文件大小验证
      // @see requirements.md — Requirement 1.1
      if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
        console.warn('[FileTransfer] File size invalid:', file.size);
        return null;
      }

      // Step 2: 队列容量检查
      // @see requirements.md — Requirement 11.4
      const { sendQueue } = get();

      // 计算当前待发送数量（队列中的待发送传输）
      const pendingCount = sendQueue.length;
      if (pendingCount >= MAX_SEND_QUEUE_SIZE) {
        console.warn('[FileTransfer] Send queue full, rejecting transfer');
        return null;
      }

      // Step 3: 生成唯一 transferId 并存储 File 引用
      const transferId = generateTransferId();

      // 📚 学习要点: 为什么在这里存储 File 引用？
      // File 对象无法序列化到 Zustand state 中（它包含文件句柄等不可序列化数据）。
      // 使用 sender.ts 的模块级 Map 存储 File 引用，通过 transferId 关联。
      // 当 processQueue() 触发 sendFile() 时，通过 transferId 取回 File 对象。
      storeFileRef(transferId, file);

      // Step 4: 存储 extraMetadata（如果提供）
      // 📚 学习要点: extraMetadata 的存储时机
      // 在 initiateTransfer 中存储，在 sendEncryptedMetadata 中消费。
      // 两者之间可能有时间差（传输在队列中排队等待），
      // 但 extraMetadataRefs Map 会持有引用直到被消费或清理。
      if (options?.extraMetadata) {
        storeExtraMetadata(transferId, options.extraMetadata);
      }

      // Step 5: 创建传输状态
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const now = Date.now();

      const transferState: TransferState = {
        transferId,
        direction: 'send',
        status: 'pending',
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
        receivedChunks: 0,
        lastReceivedIndex: -1,
        chunks: [],           // 发送方不使用 chunk 缓冲区
        startTime: now,
        lastChunkTime: now,
        senderId: '',         // 将在实际发送时由 sender.ts 填充
        senderName: '',       // 将在实际发送时由 sender.ts 填充
        ackCount: 0,
        totalReceivers: 0,    // 将在实际发送时由 sender.ts 填充
        chatMessageId: options?.chatMessageId ?? '',  // 语音消息预设，普通文件由 sender.ts 填充
      };

      // Step 5: 更新 store 状态（添加传输 + 加入队列）
      set((state) => {
        const transfers = new Map(state.transfers);
        transfers.set(transferId, transferState);
        return {
          transfers,
          sendQueue: [...state.sendQueue, transferId],
        };
      });

      // Step 6: 触发队列处理
      processQueue();

      return transferId;
    },

    cancelTransfer: (transferId: string) => {
      /**
       * 📚 学习要点: 取消传输的三种场景
       * 1. 传输在队列中（pending）：直接从队列移除，标记 cancelled
       * 2. 传输正在发送（sending）：停止发送循环，发送 MSG_SEND_FILE_CANCEL 通知服务器和接收方，标记 cancelled
       * 3. 传输正在接收（receiving）：释放缓冲区，标记 cancelled
       *
       * 对于场景 2，实际的停止发送逻辑由 sender.ts 实现（通过检查状态变化）。
       * 此方法负责：
       * - 状态更新（标记 cancelled，sender.ts 的发送循环在下次迭代时检测到并停止）
       * - 发送 MSG_SEND_FILE_CANCEL 消息（通知服务器清除 activeTransferID，通知接收方释放缓冲区）
       *
       * 📚 学习要点: 为什么取消时需要发送 MSG_SEND_FILE_CANCEL？
       * 仅在本地标记 cancelled 只能停止发送循环，但接收方不知道传输已取消：
       * - 接收方会继续等待后续 chunk，直到 60s 超时才标记失败
       * - 服务器的 activeTransferID 不会被清除，阻塞该客户端的下一次传输
       * 发送 CANCEL 消息后：
       * - 服务器立即清除 activeTransferID（允许新传输）
       * - 接收方立即释放缓冲区并显示"发送方已取消传输"（快速反馈）
       *
       * @see requirements.md — Requirement 6.1, 6.2
       */
      const { transfers } = get();
      const transfer = transfers.get(transferId);

      if (!transfer) return;

      // 只有非终态的传输可以被取消
      if (transfer.status === 'complete' || transfer.status === 'failed' || transfer.status === 'cancelled') {
        return;
      }

      // 记录取消前是否为活跃发送（用于后续发送 CANCEL 消息和触发队列处理）
      const wasActiveSend = get().activeSendId === transferId;

      // 记录取消前的状态（只有 sending 状态才需要通知服务器）
      const wasSending = transfer.status === 'sending';

      // 更新传输状态为 cancelled
      const updatedTransfer: TransferState = {
        ...transfer,
        status: 'cancelled' as TransferStatus,
      };

      set((state) => {
        const newTransfers = new Map(state.transfers);
        newTransfers.set(transferId, updatedTransfer);

        // 如果在队列中，从队列移除
        const newQueue = state.sendQueue.filter((id) => id !== transferId);

        // 如果是当前活跃发送，清除 activeSendId 并触发队列处理
        const newActiveSendId = state.activeSendId === transferId ? null : state.activeSendId;

        return {
          transfers: newTransfers,
          sendQueue: newQueue,
          activeSendId: newActiveSendId,
        };
      });

      // 📚 学习要点: 发送 MSG_SEND_FILE_CANCEL 通知服务器和接收方
      // 只有当传输处于 'sending' 状态时才需要发送 CANCEL 消息：
      // - pending 状态：还没有发送 META，服务器不知道这个传输的存在，无需通知
      // - sending 状态：已发送 META 和部分 chunk，服务器和接收方都在追踪此传输
      // - receiving 状态：本地接收取消不需要通知发送方（发送方通过 ACK 缺失感知）
      if (wasSending) {
        const cancelData: SendFileCancelData = { transferId };
        send(MSG_SEND_FILE_CANCEL, cancelData);
      }

      // 清理 extraMetadata（如果传输在队列中被取消，extraMetadata 尚未被消费）
      // 📚 学习要点: 兜底清理防止内存泄漏
      // 如果传输在 pending 状态被取消，extraMetadata 还存储在 Map 中。
      // 此时 sendEncryptedMetadata 永远不会被调用（不会消费 metadata），
      // 需要手动清理，否则 Map 中的条目会永久存在。
      cleanupExtraMetadata(transferId);

      // 如果取消的是活跃发送，触发队列处理下一个
      if (wasActiveSend) {
        processQueue();
      }
    },

    cleanupTransfer: (transferId: string) => {
      /**
       * 📚 学习要点: 资源清理的重要性
       * 传输完成/失败/取消后，需要清理以下资源：
       * 1. Blob URL：通过 URL.revokeObjectURL() 释放（防止内存泄漏）
       * 2. Chunk 缓冲区：设为空数组，让 GC 回收
       * 3. Map 条目：从 transfers Map 中删除
       *
       * 📚 学习要点: 为什么不立即清理？
       * 传输完成后，UI 仍需要显示下载按钮和文件信息。
       * 只有当消息气泡被移除时（ephemeral 超时或 MAX_MESSAGES 溢出），
       * 才调用 cleanupTransfer 释放所有资源。
       *
       * @see NFR-7 — Blob URL 内存泄漏防护
       */
      const { transfers } = get();
      const transfer = transfers.get(transferId);

      if (!transfer) return;

      // 释放 Blob URL（如果存在）
      if (transfer.blobUrl) {
        URL.revokeObjectURL(transfer.blobUrl);
      }

      // 从 Map 中移除
      set((state) => {
        const newTransfers = new Map(state.transfers);
        newTransfers.delete(transferId);

        // 如果是接收中的传输，减少活跃接收计数
        let newActiveReceiveCount = state.activeReceiveCount;
        if (transfer.direction === 'receive' &&
            (transfer.status === 'receiving' || transfer.status === 'pending')) {
          newActiveReceiveCount = Math.max(0, newActiveReceiveCount - 1);
        }

        return {
          transfers: newTransfers,
          activeReceiveCount: newActiveReceiveCount,
        };
      });
    },

    abortAllTransfers: () => {
      /**
       * 📚 学习要点: 批量中止的场景
       * 当房间关闭（MSG_ROOM_CLOSED）或用户离开房间时，
       * 所有活跃传输都应该被标记为失败并释放资源。
       *
       * 为什么标记为 'failed' 而非 'cancelled'？
       * - 'cancelled' 表示用户主动取消（有意为之）
       * - 'failed' 表示外部原因导致传输无法继续（非用户意愿）
       * - 房间关闭是外部事件，用户可能并不想取消传输
       *
       * @see requirements.md — Requirement 6.6
       */
      set((state) => {
        const newTransfers = new Map(state.transfers);

        for (const [id, transfer] of newTransfers) {
          // 只处理非终态的传输
          if (transfer.status === 'pending' ||
              transfer.status === 'sending' ||
              transfer.status === 'receiving') {
            newTransfers.set(id, {
              ...transfer,
              status: 'failed' as TransferStatus,
              error: 'Room closed, transfer interrupted',
              chunks: [], // 释放缓冲区内存
            });
          }
        }

        return {
          transfers: newTransfers,
          sendQueue: [],
          activeSendId: null,
          activeReceiveCount: 0,
        };
      });
    },

    handleSenderLeft: (senderId: string) => {
      /**
       * 📚 学习要点: 发送方离开的影响
       * 当发送方离开房间时，其所有正在进行的传输都无法继续：
       * - 服务器会广播 MSG_RELAY_FILE_CANCEL（由服务器端 handleClientDisconnect 触发）
       * - 但为了更快的 UI 反馈，我们在收到 MEMBER_LEFT 时就主动标记失败
       * - 这比等待 60s 超时要好得多（用户立即看到"发送方已离开"）
       *
       * 只影响接收方向的传输（direction === 'receive'），
       * 因为发送方向的传输是自己发起的，不受其他人离开影响。
       *
       * 委托给 receiver.ts 的 handleSenderLeft() 处理，
       * 它会同时清理超时定时器（模块级状态）。
       *
       * @see requirements.md — Requirement 6.5
       */
      receiverHandleSenderLeft(senderId);
    },

    registerTransferCompleteCallback: (
      cb: (transferId: string, blobUrl: string, metadata: FileMetadata) => void
    ) => {
      /**
       * 📚 学习要点: 回调注册的时机
       * voiceStore 在模块加载时（或首次使用时）调用此方法注册回调。
       * 注册后，所有后续的 handleFileComplete 调用都会检查 isVoice 并触发回调。
       *
       * 为什么使用 set() 而非模块级变量？
       * - 存储在 Zustand state 中，与 store 生命周期一致
       * - 可以通过 getState().onTransferComplete 在 receiver.ts 中访问
       * - 如果使用模块级变量，需要额外的导出/导入，增加耦合
       */
      set({ onTransferComplete: cb });
    },

    unregisterTransferCompleteCallback: () => {
      /**
       * 📚 学习要点: 注销回调防止内存泄漏
       * 当用户离开房间时，voiceStore 调用 cleanup() 并注销回调。
       * 这确保：
       * 1. 回调函数不再持有对已清理的 voiceStore 方法的引用
       * 2. 后续的 handleFileComplete 不会触发已失效的回调
       * 3. GC 可以正常回收 voiceStore 相关的闭包和对象
       */
      set({ onTransferComplete: undefined });
    },
  })
);

// ============================================================================
// 内部辅助函数（模块级，不暴露给外部）
// ============================================================================

/**
 * 处理发送队列：如果当前无活跃发送且队列非空，取出下一个传输开始发送。
 *
 * 📚 学习要点: 队列调度策略
 * 采用严格 FIFO（先进先出）策略：
 * - 用户先选择的文件先发送（最小惊讶原则）
 * - 不自动按文件大小排序（避免用户困惑）
 * - 同一时间只有一个活跃发送（顺序传输，简化实现）
 *
 * 为什么顺序传输而非并发？
 * 1. 服务器限制每客户端只有 1 个活跃传输（activeTransferID）
 * 2. 并发传输会导致带宽竞争，两个传输都变慢
 * 3. 顺序传输的用户体验更好：一个快速完成，然后下一个
 * 4. 简化了流控和错误处理逻辑
 *
 * 调用时机：
 * - initiateTransfer() 后（新传输加入队列）
 * - 活跃传输完成/失败/取消后
 *
 * @see requirements.md — Requirement 3.7, 11.3
 */
function processQueue(): void {
  const { activeSendId, sendQueue, transfers } = useFileTransferStore.getState();

  // 如果已有活跃发送，不处理队列
  if (activeSendId !== null) {
    return;
  }

  // 如果队列为空，无事可做
  if (sendQueue.length === 0) {
    return;
  }

  // 取出队列头部的 transferId（FIFO）
  const nextTransferId = sendQueue[0];
  const transfer = transfers.get(nextTransferId);

  // 防御性检查：如果传输状态不存在或已不是 pending，跳过并处理下一个
  if (!transfer || transfer.status !== 'pending') {
    useFileTransferStore.setState((state) => ({
      sendQueue: state.sendQueue.slice(1),
    }));
    // 递归处理下一个（尾递归优化不适用，但队列最多 3 个，不会栈溢出）
    processQueue();
    return;
  }

  // 将传输状态从 pending 更新为 sending，并设为活跃发送
  useFileTransferStore.setState((state) => {
    const newTransfers = new Map(state.transfers);
    const currentTransfer = newTransfers.get(nextTransferId);
    if (currentTransfer) {
      newTransfers.set(nextTransferId, {
        ...currentTransfer,
        status: 'sending' as TransferStatus,
        startTime: Date.now(),
      });
    }

    return {
      transfers: newTransfers,
      sendQueue: state.sendQueue.slice(1), // 从队列中移除
      activeSendId: nextTransferId,
    };
  });

  console.log('[FileTransfer] Queue processing: starting send for', nextTransferId);

  /**
   * 标记传输失败、清除活跃标记、推进队列的统一辅助函数。
   * 减少 processQueue 内多个失败路径的代码重复。
   */
  function failAndAdvance(error: string): void {
    useFileTransferStore.setState((state) => {
      const newTransfers = new Map(state.transfers);
      const t = newTransfers.get(nextTransferId);
      if (t) {
        newTransfers.set(nextTransferId, {
          ...t,
          status: 'failed' as TransferStatus,
          error,
        });
      }
      return { transfers: newTransfers, activeSendId: null };
    });
    processQueue();
  }

  // --- 预检守卫 1: WebSocket 连接检查 ---
  // @see requirements.md — Requirement 2.2, 2.3
  if (!isConnected()) {
    console.warn('[FileTransfer] WebSocket not connected, transfer failed:', nextTransferId);
    failAndAdvance('WebSocket unavailable, cannot send file');
    return;
  }

  // --- 预检守卫 2: 传输状态有效性检查 ---
  // @see requirements.md — Requirement 2.4, 2.5
  // 重新从 store 读取传输状态，防御 setState 与 sendFile 调用之间的竞态条件
  const freshTransfer = useFileTransferStore.getState().transfers.get(nextTransferId);
  if (!freshTransfer || freshTransfer.status !== 'sending') {
    console.warn('[FileTransfer] Transfer state invalidated before send, skipping:', nextTransferId);
    useFileTransferStore.setState({ activeSendId: null });
    processQueue();
    return;
  }

  // 获取房间密钥并触发发送
  // 📚 学习要点: 跨 Store 数据获取
  // processQueue 需要 roomKey（存储在 chatStore 中），但自身属于 fileTransferStore。
  // Zustand 允许通过 .getState() 在任何地方读取其他 store 的状态。
  // 这是 Zustand 相比 Redux 的优势之一：无需 Provider 嵌套或 context 传递。
  const { roomKey } = useChatStore.getState();
  if (!roomKey) {
    // 没有房间密钥（可能已离开房间），标记传输失败
    failAndAdvance('Room key unavailable, cannot encrypt file');
    return;
  }

  // 异步执行发送（不阻塞 processQueue 返回）
  // sendFile 内部会在完成/失败后自动触发 processQueue 处理下一个
  // --- .catch() 安全网：捕获 sendFile 未处理的 Promise 拒绝 ---
  // @see requirements.md — Requirement 2.1
  sendFile(nextTransferId, roomKey).catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown sendFile error';
    console.error('[FileTransfer] Unhandled promise rejection in sendFile:', errorMessage);

    // 幂等保护：仅当该传输仍为活跃发送时才标记失败（防止与离线超时重复处理）
    const currentState = useFileTransferStore.getState();
    if (currentState.activeSendId === nextTransferId) {
      useFileTransferStore.setState((state) => {
        const newTransfers = new Map(state.transfers);
        const t = newTransfers.get(nextTransferId);
        if (t && t.status === 'sending') {
          newTransfers.set(nextTransferId, {
            ...t,
            status: 'failed' as TransferStatus,
            error: errorMessage,
          });
        }
        return { transfers: newTransfers, activeSendId: null };
      });
      removeFileRef(nextTransferId);
      processQueue();
    }
  });
}

// ============================================================================
// 导出辅助函数（供 sender.ts / receiver.ts 使用）
// ============================================================================

/**
 * 触发队列处理（供外部模块调用）。
 * sender.ts 在传输完成/失败后调用此函数，启动下一个排队的传输。
 *
 * @example
 * ```typescript
 * // sender.ts 中传输完成后
 * useFileTransferStore.setState({ activeSendId: null });
 * triggerProcessQueue();
 * ```
 */
export function triggerProcessQueue(): void {
  processQueue();
}

/**
 * 获取最大并发接收数常量（供 receiver.ts 使用）。
 */
export { MAX_CONCURRENT_RECEIVES };

/**
 * 获取最大发送队列大小常量（供 UI 组件显示队列状态）。
 */
export { MAX_SEND_QUEUE_SIZE };

// ============================================================================
// 大房间警告辅助函数
// ============================================================================

/**
 * 大房间警告阈值：超过 10 位成员时显示警告。
 *
 * 📚 学习要点: 为什么选择 10 作为阈值？
 * 文件传输的带宽放大效应：服务器出口流量 = 文件大小 × (N-1)。
 * - 10 人房间：5MB × 9 = 45MB 出口流量（可接受）
 * - 20 人房间：5MB × 19 = 95MB 出口流量（开始有压力）
 * - 50 人房间：5MB × 49 = 245MB 出口流量（显著影响）
 *
 * 10 是一个平衡点：
 * - 小于等于 10 人：传输速度影响不大，无需警告
 * - 大于 10 人：传输可能明显变慢，用户应知情后再决定
 *
 * @see requirements.md — Requirement 7.6
 * @see design.md — 带宽放大效应分析
 */
const LARGE_ROOM_THRESHOLD = 10;

/**
 * 获取大房间警告消息。
 *
 * 📚 学习要点: UI 层与逻辑层的职责分离
 * 此函数只负责「判断是否需要警告」和「生成警告文案」，
 * 不负责显示确认对话框（那是 UI 组件的职责）。
 *
 * 使用方式：
 * 1. UI 组件在用户选择文件后调用 getLargeRoomWarning()
 * 2. 如果返回非 null，UI 显示确认对话框（包含返回的警告文案）
 * 3. 用户确认后，UI 调用 initiateTransfer(file)
 * 4. 用户取消后，不调用 initiateTransfer
 *
 * 为什么不在 initiateTransfer 内部处理？
 * - initiateTransfer 是同步函数，无法等待用户确认
 * - 确认对话框是 UI 行为，不应耦合到状态管理逻辑中
 * - 分离后更容易测试：可以独立测试警告逻辑和传输逻辑
 *
 * @returns 警告消息字符串（需要显示警告时），或 null（无需警告时）
 *
 * @example
 * ```typescript
 * // 在 UI 组件中使用
 * const warning = getLargeRoomWarning();
 * if (warning) {
 *   const confirmed = await showConfirmDialog(warning);
 *   if (!confirmed) return; // 用户取消
 * }
 * // 用户确认或无需警告，继续发起传输
 * initiateTransfer(file);
 * ```
 *
 * @see requirements.md — Requirement 7.6
 */
export function getLargeRoomWarning(): string | null {
  const { members } = useChatStore.getState();

  // 📚 学习要点: 为什么使用 members.length 而非 members.length - 1？
  // members 数组包含房间内所有在线成员（包括自己）。
  // 阈值判断使用总人数（包括自己），因为：
  // 1. 用户看到的房间人数是包含自己的（UI 显示"10 位成员"包含自己）
  // 2. 警告文案中的 N 也应该是用户看到的总人数（一致性）
  // 3. 实际接收方数量 = members.length - 1，但警告是给用户看的，用总数更直观
  if (members.length > LARGE_ROOM_THRESHOLD) {
    const locale = useI18nStore.getState().locale;
    return translate(locale, 'file.largeRoomWarning', { count: members.length });
  }

  return null;
}
