/**
 * @file 语音发送协调器 — 将录音结果适配为文件传输引擎的输入
 *
 * 本文件实现了 voiceSender 模块，它是语音录音和文件传输之间的「适配器」。
 * 职责：
 * 1. 将 Audio_Blob 包装为 File 对象（文件传输引擎需要 File 接口）
 * 2. 调用 fileTransferStore.initiateTransfer(file, { extraMetadata }) 进入文件传输流程
 * 3. 在聊天列表中插入语音消息占位符（ChatVoiceMessage）
 * 4. 处理 initiateTransfer 返回 null 的错误情况（队列满或文件过大）
 *
 * 📚 学习要点: 适配器模式（Adapter Pattern）
 * voiceSender 不直接处理加密或网络传输，它的角色是「翻译官」：
 * - 输入：录音引擎产出的 Blob + duration + mimeType
 * - 输出：文件传输引擎需要的 File 对象 + extraMetadata
 *
 * 为什么不让 voiceStore 直接调用 initiateTransfer？
 * 1. 关注点分离：voiceStore 管理录音/播放状态，不应关心传输细节
 * 2. 可测试性：voiceSender 是纯函数式的（给定输入产生确定行为），容易测试
 * 3. 灵活性：PttButton 作为协调者，可以在 stopRecording 和 sendVoice 之间
 *    插入额外逻辑（如确认对话框、预览等），而不需要修改 voiceStore
 *
 * 📚 学习要点: 为什么通过 initiateTransfer 而非绕过它直接调用底层 sendFile？
 * 直接调用底层 sendFile() 会绕过以下关键逻辑：
 * - 队列管理：最多 3 个待发送传输排队
 * - 互斥检查：activeSendId 确保同一时间只有一个活跃发送
 * - 状态追踪：TransferState 创建、进度更新、超时检测
 * - 文件大小验证：≤ 5MB 限制
 *
 * 通过给 initiateTransfer 增加 extraMetadata 参数（最小侵入式扩展），
 * 语音消息自动获得上述所有能力，仅需在 sendEncryptedMetadata() 中
 * 将 extraMetadata 合并到 FileMetadata 对象。
 *
 * 📚 学习要点: PttButton 的调用流程
 * PttButton 的 onRelease handler 执行以下步骤：
 * ```typescript
 * const result = await voiceStore.stopRecording();
 * if (result) {
 *   sendVoice(result.blob, result.duration, result.mimeType);
 * }
 * ```
 * voiceSender 不依赖 voiceStore 的内部状态 — 它只接收录音结果作为参数。
 * 这种设计让 voiceSender 成为一个无状态的纯函数模块。
 *
 * @module voice/voiceSender
 * @see fileTransferStore.ts — initiateTransfer, extraMetadata 机制
 * @see sender.ts — sendEncryptedMetadata 合并 extraMetadata
 * @see protocol.ts — ChatVoiceMessage 接口
 * @see design.md — Voice Sender 设计
 */

import { useFileTransferStore } from '../file-transfer/fileTransferStore';
import { MAX_FILE_SIZE } from '../file-transfer/types';
import { generateChatMessageId } from '../file-transfer/chatMessageId';
import { useChatStore } from '../stores/chatStore';
import { useI18nStore } from '../i18n/store';
import { translate } from '../i18n/translate';
import { useVoiceStore } from './voiceStore';
import type { ChatVoiceMessage } from '../network/protocol';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取当前 locale 并翻译 i18n key。
 *
 * 📚 学习要点: 在非 React 上下文中使用 i18n
 * voiceSender 是纯逻辑模块（非 React 组件），不能使用 useTranslation() hook。
 * 直接通过 useI18nStore.getState().locale 同步获取当前语言设置，
 * 然后调用 translate(locale, key) 获取翻译文本。
 * 这与 voiceStore.ts 和 recorder.ts 中的 t() 辅助函数模式一致。
 */
function t(key: Parameters<typeof translate>[1]): string {
  const locale = useI18nStore.getState().locale;
  return translate(locale, key);
}

/**
 * 生成语音文件名，格式为 `voice_YYYYMMDD_HHmmss.{ext}`。
 *
 * 📚 学习要点: 文件名格式设计
 * 使用时间戳作为文件名有以下好处：
 * 1. 唯一性：精确到秒的时间戳在单用户场景下几乎不会重复
 * 2. 可排序：按文件名排序即按时间排序
 * 3. 可读性：用户在文件管理器中能看到录音时间
 * 4. 兼容性：只使用字母、数字和下划线，所有文件系统都支持
 *
 * 扩展名根据 mimeType 决定：
 * - audio/webm → .webm（Chrome, Firefox, Edge）
 * - audio/mp4 → .mp4（Safari）
 * - 其他 → .webm（默认回退）
 *
 * @param mimeType - 录音的 MIME 类型
 * @returns 格式化的文件名，如 "voice_20240115_143025.webm"
 */
function generateVoiceFileName(mimeType: string): string {
  const now = new Date();

  // 📚 学习要点: 手动格式化日期而非使用 Intl.DateTimeFormat
  // Intl.DateTimeFormat 的输出格式因 locale 而异，不适合生成固定格式的文件名。
  // 手动拼接确保格式始终为 YYYYMMDD_HHmmss，与 locale 无关。
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  // 根据 mimeType 确定文件扩展名
  const ext = mimeType.includes('ogg')
    ? 'ogg'
    : mimeType.includes('mp4')
      ? 'mp4'
      : 'webm';

  return `voice_${year}${month}${day}_${hours}${minutes}${seconds}.${ext}`;
}

// ============================================================================
// 核心导出函数
// ============================================================================

/**
 * 发送语音消息 — 将 Audio_Blob 通过文件传输引擎加密发送。
 *
 * 📚 学习要点: sendVoice 的完整执行流程
 * 1. 将 Blob 包装为 File 对象（文件传输引擎需要 File 接口）
 * 2. 调用 fileTransferStore.initiateTransfer(file, { extraMetadata })
 *    - extraMetadata 包含 { isVoice: true, duration }
 *    - initiateTransfer 内部：验证大小 → 生成 transferId → 存储 extraMetadata → 入队
 * 3. 如果 initiateTransfer 返回 null → 队列满或文件过大，显示错误
 * 4. 如果成功 → 在聊天列表中插入 ChatVoiceMessage 占位符
 *    - 占位符包含 subType: 'voice' 和 duration，用于 UI 渲染语音气泡
 *    - 实际的加密和发送由 processQueue → sendFile 异步执行
 *
 * 📚 学习要点: 为什么在 voiceSender 中插入聊天占位符？
 * sender.ts 的 insertChatFileMessage() 在 sendFile() 内部调用（processQueue 触发时），
 * 但语音消息需要在用户松开 PTT 的瞬间就显示占位符（乐观渲染），
 * 而不是等到 processQueue 实际开始发送时才显示。
 * 因此 voiceSender 在 initiateTransfer 成功后立即插入占位符，
 * 而 sender.ts 的 insertChatFileMessage 会被跳过（通过 transferState.chatMessageId 已设置来判断）。
 *
 * @param blob - 录音完成的 Audio Blob
 * @param duration - 录音时长（秒），通过 Date.now() 差值计算
 * @param mimeType - 实际使用的 MIME 类型（如 'audio/webm;codecs=opus'）
 */
export function sendVoice(blob: Blob, duration: number, mimeType: string): void {
  // ─── Step 1: 将 Blob 包装为 File 对象 ─────────────────────────────
  // 📚 学习要点: Blob vs File
  // MediaRecorder 产出的是 Blob（无文件名），但 fileTransferStore.initiateTransfer
  // 需要 File 对象（有文件名、lastModified 等属性）。
  // new File([blob], filename, { type }) 创建一个 File 对象，
  // 它继承自 Blob，额外包含 name 和 lastModified 属性。
  const fileName = generateVoiceFileName(mimeType);
  const file = new File([blob], fileName, { type: mimeType });

  // ─── Step 2: 调用 initiateTransfer 进入文件传输流程 ────────────────
  // 📚 学习要点: extraMetadata 的传递路径
  // { isVoice: true, duration } 会被存储在 extraMetadataRefs Map 中，
  // 当 processQueue 触发 sendFile → sendEncryptedMetadata 时，
  // 通过 consumeExtraMetadata(transferId) 取出并合并到 FileMetadata 对象中，
  // 最终被 AES-GCM 加密后发送。接收方解密后检查 isVoice 字段决定渲染方式。
  const { initiateTransfer } = useFileTransferStore.getState();

  // ─── Step 2b: 预生成 chatMessageId 解决竞态条件 ────────────────────
  // 📚 学习要点: 为什么需要预生成 chatMessageId？
  // initiateTransfer 内部会调用 processQueue()，processQueue 同步调用 sendFile()。
  // sendFile 在第一个 await 之前会检查 transfer.chatMessageId：
  //   - 如果为空 → 插入 ChatFileMessage（文件传输卡片）
  //   - 如果非空 → 跳过（语音消息已有占位符）
  // 如果不预设 chatMessageId，sendFile 会在 insertVoiceChatMessage 之前执行，
  // 导致用户同时看到文件传输卡片和语音气泡（重复渲染）。
  // 解决方案：预生成 chatMessageId，通过 options.chatMessageId 传入 initiateTransfer，
  // 使 TransferState 创建时就带有正确的 chatMessageId。
  const preGeneratedChatMessageId = generateChatMessageId('voice');

  const transferId = initiateTransfer(file, {
    extraMetadata: { isVoice: true, duration },
    chatMessageId: preGeneratedChatMessageId,
  });

  // ─── Step 3: 处理 initiateTransfer 返回 null 的错误情况 ────────────
  // 📚 学习要点: initiateTransfer 返回 null 的两种原因
  // 1. 文件大小超过 MAX_FILE_SIZE (5MB) → 显示 'voice.error.tooLarge'
  // 2. 发送队列已满 (≥ 3 个待发送) → 显示 'voice.error.transferBusy'
  //
  // 区分方式：检查 blob.size 是否超过限制。
  // 如果大小合法但仍返回 null，说明是队列满。
  if (transferId === null) {
    if (file.size > MAX_FILE_SIZE) {
      // 语音文件过大（理论上 60 秒 Opus 不会超过 5MB，但防御性处理）
      console.warn('[VoiceSender] Voice file too large:', file.size);
      // 📚 学习要点: 错误通知策略
      // voiceSender 是无状态模块，不持有 UI 状态。
      // 将错误信息设置到 voiceStore.voiceError 中，
      // UI 组件（VoiceErrorToast）订阅此字段并显示错误提示。
      useVoiceStore.setState({ voiceError: t('voice.error.tooLarge') });
    } else {
      // 队列满（有其他文件/语音正在排队发送）
      console.warn('[VoiceSender] Transfer queue full or busy');
      useVoiceStore.setState({ voiceError: t('voice.error.transferBusy') });
    }
    return;
  }

  // ─── Step 4: 在聊天列表中插入语音消息占位符 ────────────────────────
  // 📚 学习要点: 使用预生成的 chatMessageId
  // chatMessageId 已通过 options 传入 initiateTransfer，TransferState 创建时就设置好了。
  // 这里插入聊天消息时使用相同的 ID，确保传输状态与聊天消息正确关联。
  // sendFile 检查 transfer.chatMessageId 时会发现非空，跳过重复插入。
  insertVoiceChatMessage(transferId, file, duration, preGeneratedChatMessageId);

  // ─── Step 5: 注册本地 Blob URL 供发送方回放 ────────────────────────
  // 📚 学习要点: 发送方自己的语音消息也需要可回放
  // 发送方不会收到 handleFileComplete 回调（那是接收方的流程），
  // 因此需要在发送前主动将 Blob URL 注册到 voiceStore 的 blobCache 中。
  // 这样发送方在聊天列表中看到自己的语音气泡时，点击播放按钮可以正常回放。
  const localBlobUrl = URL.createObjectURL(blob);
  useVoiceStore.getState().registerVoiceBlob(transferId, localBlobUrl);
}

/**
 * 在聊天列表中插入语音消息占位符。
 *
 * 📚 学习要点: 为什么单独抽取为函数？
 * 1. 保持 sendVoice 主流程清晰（每个步骤一个函数调用）
 * 2. 方便单元测试（可以独立测试占位符插入逻辑）
 * 3. 与 sender.ts 的 insertChatFileMessage 模式一致
 *
 * 📚 学习要点: ChatVoiceMessage 与 ChatFileMessage 的关系
 * ChatVoiceMessage 继承 ChatFileMessage，额外添加 subType: 'voice' 和 duration。
 * MessageList.tsx 在渲染时：
 * - 先检查 isVoiceMessage(msg) → 渲染 <VoiceMessage />
 * - 再检查 isFileMessage(msg) → 渲染 <FileMessage />
 * 由于 ChatVoiceMessage 的 type 也是 'file'，isFileMessage 对它也返回 true，
 * 所以检查顺序很重要（先具体后宽泛）。
 *
 * @param transferId - 传输唯一标识符（由 initiateTransfer 生成）
 * @param file - 包装后的 File 对象（用于提取文件名、大小、类型）
 * @param duration - 语音时长（秒）
 */
function insertVoiceChatMessage(transferId: string, file: File, duration: number, chatMessageId: string): void {
  const { myId, myName } = useChatStore.getState();
  const timestamp = Date.now();

  // 📚 学习要点: ChatVoiceMessage 结构
  // 继承 ChatFileMessage 的所有字段（id, senderId, type:'file', transferId 等），
  // 额外添加 subType:'voice' 和 duration 用于 UI 区分渲染。
  const voiceMessage: ChatVoiceMessage = {
    id: chatMessageId,
    stableId: `${myId ?? 'unknown'}-${timestamp}`,
    senderId: myId ?? '',
    senderName: myName ?? '',
    text: '',  // 语音消息不使用 text 字段
    timestamp,
    isMine: true,
    isSystem: false,
    type: 'file',       // 保持与 ChatFileMessage 一致（向后兼容）
    transferId,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'application/octet-stream',
    subType: 'voice',   // 语音消息标识（UI 条件渲染的判别字段）
    duration,           // 语音时长（秒），用于气泡显示 "0:05"
  };

  // 插入到 chatStore 的 messages 数组中
  // 📚 学习要点: 跨 Store 操作
  // 与 sender.ts 的 insertChatFileMessage 相同的模式：
  // 直接通过 useChatStore.setState() 修改聊天消息列表。
  // Zustand 允许在任何地方通过 .setState() 修改状态，不限于组件内部。
  useChatStore.setState((state) => {
    const messages = [...state.messages, voiceMessage as unknown as typeof state.messages[0]];
    // 遵守 MAX_MESSAGES 限制（与 chatStore 内部逻辑一致）
    return {
      messages: messages.length > 200 ? messages.slice(-200) : messages,
    };
  });

  // 更新 TransferState 的发送方信息
  // 📚 学习要点: chatMessageId 已通过 initiateTransfer options 预设
  // 此处不再需要设置 chatMessageId（已在 TransferState 创建时设置），
  // 但仍需设置 senderId 和 senderName（initiateTransfer 不知道这些信息）。
  useFileTransferStore.setState((state) => {
    const transfers = new Map(state.transfers);
    const transfer = transfers.get(transferId);
    if (transfer) {
      transfers.set(transferId, {
        ...transfer,
        senderId: myId ?? '',
        senderName: myName ?? '',
      });
    }
    return { transfers };
  });
}
