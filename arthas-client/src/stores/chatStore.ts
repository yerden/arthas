/**
 * Chat state management using Zustand.
 * Integrates crypto layer (encrypt/decrypt) and network layer (WebSocket).
 */

import { create } from 'zustand';
import * as ws from '../network/websocket';
import {
  MSG_CREATE_ROOM,
  MSG_JOIN_ROOM,
  MSG_SEND_MESSAGE,
  MSG_LEAVE_ROOM,
  MSG_TYPING,
  MSG_SEND_REACTION,
  MSG_ROOM_CREATED,
  MSG_ROOM_JOINED,
  MSG_MEMBER_JOINED,
  MSG_MEMBER_LEFT,
  MSG_RELAY_MESSAGE,
  MSG_RELAY_REACTION,
  MSG_MEMBER_TYPING,
  MSG_ROOM_CLOSED,
  MSG_ERROR,
  // 文件传输中转消息类型（Server → Client, 0x1A-0x1E）
  // 📚 学习要点: 文件传输消息路由
  // chatStore 作为所有服务器消息的统一入口，负责将文件传输消息分发给 fileTransferStore。
  // 这种「中央路由 + 委托处理」模式保持了消息处理的单一入口点，
  // 同时通过委托实现了关注点分离（chatStore 不需要了解文件传输的内部逻辑）。
  MSG_RELAY_FILE_META,
  MSG_RELAY_FILE_CHUNK,
  MSG_RELAY_FILE_COMPLETE,
  MSG_RELAY_FILE_CANCEL,
  MSG_RELAY_FILE_ACK,
  type Message,
  type RoomCreatedData,
  type RoomJoinedData,
  type MemberJoinedData,
  type MemberLeftData,
  type RelayMessageData,
  type RelayReactionData,
  type MemberTypingData,
  type RoomClosedData,
  type ErrorData,
  type CreateRoomData,
} from '../network/protocol';
import { generateRoomKey, exportRoomKey, importRoomKey } from '../crypto/keys';
import { encryptMessage } from '../crypto/encrypt';
import { decryptMessage } from '../crypto/decrypt';
import { encodeShareKey, decodeShareKey } from '../crypto/shareKey';
import { encryptTypingStatus, decryptTypingStatus } from '../crypto/typingEncrypt';
import { useFileTransferStore } from '../file-transfer/fileTransferStore';
import { useMatchStore } from '../match/matchStore';
import { useVoiceStore } from '../voice/voiceStore';
import { playNotificationSound, showDesktopNotification, playJoinSound, playLeaveSound } from '../utils/notification';
import { buildPayload, parseSignedPayload, makeStableId, buildSignedPayload } from '../utils/payload';
import { hashPassword } from '../utils/crypto';
import { useI18nStore } from '../i18n/store';
import { translate } from '../i18n/translate';
import {
  generateSigningKeyPair,
  encodePublicKey,
  importVerifyKey,
  decodePublicKey,
  verifySignature,
  type SigningKeyPair,
} from '../crypto/signing';
import { computeSignableBytes } from '../crypto/canonicalJson';
import { DeferredVerificationQueue, verifyMessageSignature } from '../crypto/verifyMessage';

// ===== Types =====

export interface ReplyData {
  stableId: string;
  senderName: string;
  preview: string;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

/**
 * 公钥缓存条目 — 存储成员的 Ed25519 公钥及导入后的 CryptoKey。
 *
 * 📚 学习要点: 为什么缓存 CryptoKey？
 * `importVerifyKey` 是一个异步操作（调用 Web Crypto API）。
 * 每次验证消息时重新导入公钥会产生不必要的性能开销。
 * 因此在收到公钥广播时导入一次，将 CryptoKey 缓存在 publicKeyMap 中，
 * 后续所有验证操作直接使用缓存的 CryptoKey。
 */
export interface PublicKeyEntry {
  /** 32 字节原始公钥（用于比较和重新编码） */
  raw: Uint8Array;
  /** 已导入的 CryptoKey（用于 verifySignature，避免重复 import） */
  cryptoKey: CryptoKey;
  /** 首次收到该公钥的时间戳（用于 TOFU 冲突检测） */
  firstSeen: number;
}

export interface ChatMessage {
  id: string;
  stableId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isMine: boolean;
  isSystem: boolean;
  reply?: ReplyData;
  /**
   * 签名验证状态（一次性计算，结果缓存，不重复验证）。
   * - 'verified': 签名验证通过
   * - 'failed': 签名验证失败（可能被篡改）
   * - 'unknown': 公钥未知，无法验证
   * - 'no-sig': 消息无签名（旧客户端或不支持 Ed25519）
   */
  verificationStatus?: 'verified' | 'failed' | 'unknown' | 'no-sig';
}

export interface Member {
  id: string;
  name: string;
  color: string;
}

export interface ChatState {
  // Connection
  connected: boolean;
  myId: string | null;
  myName: string;

  // Room
  roomId: string | null;
  roomKey: CryptoKey | null;
  shareCode: string | null;
  members: Member[];
  hasPassword: boolean;
  ephemeral: number;
  /** 房间过期时间戳（Unix 秒），0 表示无过期。来源：服务器 RoomCreated/RoomJoined 响应 */
  expiresAt: number;

  // Messages
  messages: ChatMessage[];
  typingMembers: Map<string, number>;

  // Notification
  muted: boolean;

  // Reply
  replyTo: ReplyData | null;

  // Reactions
  reactions: Map<string, Reaction[]>;

  // Ed25519 Signing (Phase 8)
  /** 当前会话的 Ed25519 签名密钥对（null = 浏览器不支持 Ed25519） */
  signingKeyPair: SigningKeyPair | null;
  /** memberId → 缓存的公钥条目（含已导入的 CryptoKey） */
  publicKeyMap: Map<string, PublicKeyEntry>;

  // Actions
  connect: () => void;
  createRoom: (name: string, password?: string, ephemeral?: number, expiry?: number, publicData?: { title: string; description: string; tags: string[] }) => Promise<void>;
  joinRoom: (shareCode: string, name: string, password?: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  leaveRoom: () => void;
  toggleMute: () => void;
  setReplyTo: (reply: ReplyData) => void;
  clearReply: () => void;
  sendReaction: (stableId: string, emoji: string) => void;

  // Internal
  handleServerMessage: (msg: Message) => void;
}

// ===== Constants =====

const MAX_MESSAGES = 200;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 10;
const TYPING_TIMEOUT_MS = 2000;

// ===== Rate limiter state (module-level to avoid store bloat) =====

const messageTimes: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Remove timestamps older than the window
  while (messageTimes.length > 0 && now - messageTimes[0] > RATE_LIMIT_WINDOW_MS) {
    messageTimes.shift();
  }
  return messageTimes.length >= RATE_LIMIT_MAX;
}

function recordMessageSent(): void {
  messageTimes.push(Date.now());
}

// ===== Ephemeral message removal =====

function scheduleEphemeralRemoval(msgId: string, ephemeral: number): void {
  if (ephemeral <= 0) return;
  setTimeout(() => {
    useChatStore.setState((state) => ({
      messages: state.messages.filter((m) => m.id !== msgId),
    }));
  }, ephemeral * 1000);
}

// ===== Typing debounce state =====

let typingTimer: ReturnType<typeof setTimeout> | null = null;
let isCurrentlyTyping = false;

// ===== Connection poll state =====

/** 连接状态轮询 interval ID，确保重复调用 connect() 不会产生多个轮询 */
let connectionPollInterval: number | null = null;

// 📚 学习要点: 异步加密的 last-write-wins 策略
// setTyping 变为 async 后，加密操作可能在 in-flight 时被新的 typing 事件覆盖。
// 使用版本计数器（typingVersion）实现 last-write-wins：
// - 每次 setTyping 调用时递增版本号
// - 加密完成后检查版本号是否仍为当前值
// - 如果版本号已过期（有更新的调用），丢弃加密结果，不发送
// 这确保了快速连续的 typing 事件只发送最终状态，避免乱序。
let typingVersion = 0;

// ===== Deferred Verification Queue (module-level) =====

/**
 * 📚 学习要点: 为什么延迟验证队列放在模块级别？
 * DeferredVerificationQueue 管理定时器和回调，不适合放在 Zustand store 内部
 * （store 状态应为可序列化的纯数据）。模块级实例在 leaveRoom 时调用 clear() 重置。
 */
let deferredQueue: DeferredVerificationQueue = new DeferredVerificationQueue(
  (_senderId, messages) => {
    // 超时回调：将所有待验证消息标记为 'unknown'
    useChatStore.setState((state) => {
      const updatedMessages = state.messages.map((msg) => {
        const pending = messages.find((m) => m.messageId === msg.id);
        if (pending) {
          return { ...msg, verificationStatus: 'unknown' as const };
        }
        return msg;
      });
      return { messages: updatedMessages };
    });
  }
);

// ===== Unique ID generator =====

let messageCounter = 0;

function generateMessageId(): string {
  return `${Date.now()}-${++messageCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ===== Store =====

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  connected: false,
  myId: null,
  myName: '',
  roomId: null,
  roomKey: null,
  shareCode: null,
  members: [],
  hasPassword: false,
  ephemeral: 0,
  expiresAt: 0,
  messages: [],
  typingMembers: new Map(),
  muted: localStorage.getItem('arthas_muted') === 'true',
  replyTo: null,
  reactions: new Map(),
  signingKeyPair: null,
  publicKeyMap: new Map(),

  connect: () => {
    ws.onMessage((msg: Message) => {
      get().handleServerMessage(msg);
    });
    ws.connect();
    // Track connection state via polling (ws module exposes isConnected).
    // 使用模块级变量存储 interval ID，确保重复调用 connect() 时
    // 不会产生多个轮询（React StrictMode 防护）。
    if (connectionPollInterval !== null) {
      clearInterval(connectionPollInterval);
    }
    const checkConnection = () => {
      const wasConnected = get().connected;
      const nowConnected = ws.isConnected();
      if (wasConnected !== nowConnected) {
        set({ connected: nowConnected });
      }
    };
    connectionPollInterval = setInterval(checkConnection, 500) as unknown as number;
  },

  createRoom: async (name: string, password?: string, ephemeral?: number, expiry?: number, publicData?: { title: string; description: string; tags: string[] }) => {
    const roomKey = await generateRoomKey();
    const hashedPwd = await hashPassword(password ?? '');

    // 📚 学习要点: Ed25519 密钥对生命周期
    // 密钥对在创建/加入房间时生成，仅存在于内存中。
    // 如果浏览器不支持 Ed25519，generateSigningKeyPair 返回 null，
    // 客户端以 no-sig 模式运行（消息正常加密发送，只是没有签名）。
    const keyPair = await generateSigningKeyPair();

    set({ myName: name, roomKey, ephemeral: ephemeral ?? 0, signingKeyPair: keyPair, publicKeyMap: new Map() });

    // Build create room payload with proper type
    const payload: CreateRoomData = {
      name,
      password: hashedPwd,
      ephemeral: ephemeral ?? 0,
      expiry: expiry ?? 0,
    };

    // If public listing requested, include public fields + exported key
    if (publicData) {
      const keyEncoded = await exportRoomKey(roomKey);
      payload.public = true;
      payload.title = publicData.title;
      payload.description = publicData.description;
      payload.tags = publicData.tags;
      payload.keyEncoded = keyEncoded;
    }

    ws.send(MSG_CREATE_ROOM, payload);
  },

  joinRoom: async (shareCode: string, name: string, password?: string) => {
    const decoded = decodeShareKey(shareCode);
    if (!decoded) {
      // Invalid share code — add system error message
      const locale = useI18nStore.getState().locale;
      const errorMsg: ChatMessage = {
        id: generateMessageId(),
        stableId: '',
        senderId: 'system',
        senderName: 'System',
        text: translate(locale, 'system.invalidShareCode'),
        timestamp: Date.now(),
        isMine: false,
        isSystem: true,
      };
      set((state) => ({ messages: [...state.messages, errorMsg] }));
      return;
    }

    const { roomId, keyEncoded, ephemeral } = decoded;
    const roomKey = await importRoomKey(keyEncoded);
    const hashedPwd = await hashPassword(password ?? '');

    // Generate Ed25519 keypair for signing (null if unsupported)
    const keyPair = await generateSigningKeyPair();

    set({ myName: name, roomKey, shareCode, ephemeral, signingKeyPair: keyPair, publicKeyMap: new Map() });
    ws.send(MSG_JOIN_ROOM, { roomId, name, password: hashedPwd });
  },

  sendMessage: async (text: string) => {
    const { roomKey, myId, myName, replyTo, signingKeyPair } = get();
    if (!roomKey || !myId) return;

    // Rate limiting check
    if (isRateLimited()) {
      const locale = useI18nStore.getState().locale;
      const errorMsg: ChatMessage = {
        id: generateMessageId(),
        stableId: '',
        senderId: 'system',
        senderName: 'System',
        text: translate(locale, 'system.rateLimited'),
        timestamp: Date.now(),
        isMine: false,
        isSystem: true,
      };
      set((state) => ({ messages: [...state.messages, errorMsg] }));
      return;
    }

    // 📚 学习要点: 消息签名的 graceful degradation
    // 使用 buildSignedPayload 尝试对消息进行 Ed25519 签名。
    // 如果签名失败（异常情况），回退到无签名的 buildPayload，
    // 确保消息仍能正常发送（可用性优先于签名完整性）。
    // signingKeyPair?.privateKey 为 null 时，buildSignedPayload 内部跳过签名步骤。
    let payload: string;
    try {
      payload = await buildSignedPayload(
        text,
        signingKeyPair?.privateKey ?? null,
        replyTo
      );
    } catch (err) {
      // Signing failed — fall back to unsigned payload
      console.warn('[Security] Message signing failed, sending without signature:', err);
      payload = buildPayload(text, replyTo);
    }

    // Encrypt
    const { iv, ciphertext } = await encryptMessage(roomKey, payload);

    // Send over WebSocket
    ws.send(MSG_SEND_MESSAGE, { iv, ciphertext });
    recordMessageSent();

    // Optimistic local render
    // 📚 学习要点: 自己的消息为什么标记为 'verified'？
    // 本地发送的消息无需签名验证 — 我们知道它来自自己（inherently trusted）。
    // 设置 verificationStatus: 'verified' 让 UI 对自己的消息显示 ✓ 图标，
    // 与通过签名验证的远程消息保持一致的视觉反馈。
    const timestamp = Date.now();
    const localMsg: ChatMessage = {
      id: generateMessageId(),
      stableId: makeStableId(myId, timestamp),
      senderId: myId,
      senderName: myName,
      text,
      timestamp,
      isMine: true,
      isSystem: false,
      reply: replyTo ?? undefined,
      verificationStatus: 'verified',
    };

    set((state) => {
      const updated = [...state.messages, localMsg];
      return {
        messages: updated.length > MAX_MESSAGES ? updated.slice(-MAX_MESSAGES) : updated,
        replyTo: null, // Clear reply after sending
      };
    });

    // Schedule ephemeral removal for sent messages
    const { ephemeral } = get();
    if (ephemeral > 0 && !localMsg.isSystem) {
      scheduleEphemeralRemoval(localMsg.id, ephemeral);
    }
  },

  setTyping: async (typing: boolean) => {
    if (typing === isCurrentlyTyping) return;

    const { roomKey } = get();

    if (typing) {
      isCurrentlyTyping = true;

      // Encrypt and send typing:true (last-write-wins via version counter)
      const myVersion = ++typingVersion;
      if (roomKey) {
        try {
          const encrypted = await encryptTypingStatus(roomKey, true);
          // Check if this call is still the latest (no newer setTyping call has occurred)
          if (typingVersion === myVersion) {
            ws.send(MSG_TYPING, encrypted);
          }
        } catch {
          // Encryption failed — silently skip (don't break typing flow)
        }
      }

      // Auto-cancel after timeout
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(async () => {
        isCurrentlyTyping = false;
        typingTimer = null;

        const currentRoomKey = get().roomKey;
        const cancelVersion = ++typingVersion;
        if (currentRoomKey) {
          try {
            const encrypted = await encryptTypingStatus(currentRoomKey, false);
            if (typingVersion === cancelVersion) {
              ws.send(MSG_TYPING, encrypted);
            }
          } catch {
            // Encryption failed — silently skip
          }
        }
      }, TYPING_TIMEOUT_MS);
    } else {
      isCurrentlyTyping = false;
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }

      // Encrypt and send typing:false (last-write-wins via version counter)
      const myVersion = ++typingVersion;
      if (roomKey) {
        try {
          const encrypted = await encryptTypingStatus(roomKey, false);
          if (typingVersion === myVersion) {
            ws.send(MSG_TYPING, encrypted);
          }
        } catch {
          // Encryption failed — silently skip
        }
      }
    }
  },

  leaveRoom: () => {
    ws.send(MSG_LEAVE_ROOM, {});

    // Clear typing timers
    const { typingMembers } = get();
    typingMembers.forEach((handle) => clearTimeout(handle));

    // Clear deferred verification queue (cancel all pending timers)
    deferredQueue.clear();

    // 📚 学习要点: 语音模块资源清理（离开房间时）
    // 离开房间时必须释放所有语音相关资源：
    // 1. cancelRecording(): 如果用户正在录音，立即停止并释放麦克风
    //    - 停止 MediaRecorder，释放 MediaStream tracks（麦克风指示灯熄灭）
    //    - 重置录音状态为 idle
    // 2. cleanup(): 释放所有已缓存的语音 Blob URL 和播放状态
    //    - 停止当前播放（如果有语音正在播放）
    //    - 对所有缓存的 Blob URL 调用 URL.revokeObjectURL()（防止内存泄漏）
    //    - 重置 blobCache、lruOrder、playbackStates 等状态
    //
    // 为什么两个调用都需要？
    // - cancelRecording 处理录音引擎（MediaRecorder + MediaStream）
    // - cleanup 处理播放引擎和 Blob 缓存
    // 它们管理不同的资源，互不重叠。
    useVoiceStore.getState().cancelRecording();
    useVoiceStore.getState().cleanup();

    // Reset room state (including signing keypair and public key map)
    set({
      roomId: null,
      roomKey: null,
      shareCode: null,
      members: [],
      hasPassword: false,
      ephemeral: 0,
      expiresAt: 0,
      messages: [],
      typingMembers: new Map(),
      replyTo: null,
      reactions: new Map(),
      signingKeyPair: null,
      publicKeyMap: new Map(),
    });

    // Reset module-level state
    isCurrentlyTyping = false;
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    messageTimes.length = 0;
  },

  toggleMute: () => {
    const newMuted = !get().muted;
    localStorage.setItem('arthas_muted', String(newMuted));
    set({ muted: newMuted });
  },

  setReplyTo: (reply: ReplyData) => {
    set({ replyTo: reply });
  },

  clearReply: () => {
    set({ replyTo: null });
  },

  sendReaction: (stableId: string, emoji: string) => {
    const { myId, roomKey, reactions } = get();
    if (!myId || !roomKey) return;

    const msgReactions = reactions.get(stableId) || [];
    const myExisting = msgReactions.find((r) => r.userIds.includes(myId));

    const encryptAndSend = async (targetStableId: string, targetEmoji: string, action: 'add' | 'remove') => {
      const payload = JSON.stringify({ stableId: targetStableId, emoji: targetEmoji, action });
      const { iv, ciphertext } = await encryptMessage(roomKey, payload);
      ws.send(MSG_SEND_REACTION, { iv, ciphertext });
    };

    const updateLocal = (targetEmoji: string, action: 'add' | 'remove') => {
      set((state) => {
        const current = new Map(state.reactions);
        const list = [...(current.get(stableId) || [])];

        if (action === 'add') {
          const existing = list.find((r) => r.emoji === targetEmoji);
          if (existing) {
            existing.userIds = [...existing.userIds, myId];
          } else {
            list.push({ emoji: targetEmoji, userIds: [myId] });
          }
        } else {
          const existing = list.find((r) => r.emoji === targetEmoji);
          if (existing) {
            existing.userIds = existing.userIds.filter((id) => id !== myId);
            if (existing.userIds.length === 0) {
              const idx = list.indexOf(existing);
              list.splice(idx, 1);
            }
          }
        }

        current.set(stableId, list);
        return { reactions: current };
      });
    };

    if (myExisting) {
      if (myExisting.emoji === emoji) {
        // Toggle off
        encryptAndSend(stableId, emoji, 'remove');
        updateLocal(emoji, 'remove');
      } else {
        // Switch: remove old + add new
        encryptAndSend(stableId, myExisting.emoji, 'remove');
        encryptAndSend(stableId, emoji, 'add');
        updateLocal(myExisting.emoji, 'remove');
        updateLocal(emoji, 'add');
      }
    } else {
      // New reaction
      encryptAndSend(stableId, emoji, 'add');
      updateLocal(emoji, 'add');
    }
  },

  handleServerMessage: (msg: Message) => {
    switch (msg.type) {
      case MSG_ROOM_CREATED: {
        const data = msg.data as RoomCreatedData;
        const { roomKey, ephemeral } = get();

        // 📚 学习要点: expiresAt 来源于服务器响应
        // 服务器是过期时间的唯一权威来源。客户端存储 expiresAt 用于：
        // 1. 倒计时显示（ExpiryCountdown 组件）
        // 2. 编码到分享码中（信息性，帮助加入者判断房间是否仍有效）
        const expiresAt = data.expiresAt ?? 0;

        // Generate share code asynchronously (includes ephemeral and expiresAt info)
        if (roomKey) {
          encodeShareKey(data.roomId, roomKey, ephemeral, expiresAt).then((code) => {
            set({ shareCode: code });
          });
        }

        set({ roomId: data.roomId, expiresAt });
        break;
      }

      case MSG_ROOM_JOINED: {
        const data = msg.data as RoomJoinedData;
        const members: Member[] = data.members.map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
        }));

        // The last member in the list is us (just joined)
        const myId = members[members.length - 1]?.id ?? get().myId;

        set({
          roomId: data.roomId,
          members,
          myId,
          hasPassword: data.hasPassword ?? false,
          ephemeral: data.ephemeral ?? 0,
          expiresAt: data.expiresAt ?? 0,
        });

        // 📚 学习要点: 公钥广播时机
        // 在收到 RoomJoined 确认后立即广播公钥，确保：
        // 1. 我们已经有了 roomKey（加密广播消息需要）
        // 2. 服务器已确认我们在房间中（消息能被中转）
        // 如果 signingKeyPair 为 null（Ed25519 不支持），跳过广播。
        const { signingKeyPair, roomKey } = get();
        if (signingKeyPair && roomKey) {
          const encodedPubkey = encodePublicKey(signingKeyPair.publicKeyBytes);
          buildSignedPayload('', signingKeyPair.privateKey, null, 'pubkey', encodedPubkey)
            .then((payload) => encryptMessage(roomKey, payload))
            .then(({ iv, ciphertext }) => {
              ws.send(MSG_SEND_MESSAGE, { iv, ciphertext });
            })
            .catch((err) => {
              console.warn('[Security] Failed to broadcast public key:', err);
            });
        }
        break;
      }

      case MSG_MEMBER_JOINED: {
        const data = msg.data as MemberJoinedData;
        const newMember: Member = { id: data.id, name: data.name, color: data.color };

        const locale = useI18nStore.getState().locale;
        const systemMsg: ChatMessage = {
          id: generateMessageId(),
          stableId: '',
          senderId: 'system',
          senderName: 'System',
          text: translate(locale, 'system.userJoined', { name: data.name }),
          timestamp: Date.now(),
          isMine: false,
          isSystem: true,
        };

        set((state) => {
          const messages = [...state.messages, systemMsg];
          return {
            members: [...state.members, newMember],
            messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
          };
        });

        // Play join sound
        if (!get().muted) playJoinSound();
        break;
      }

      case MSG_MEMBER_LEFT: {
        const data = msg.data as MemberLeftData;

        // Find member name before removing
        const leavingMember = get().members.find((m) => m.id === data.id);
        const memberName = leavingMember?.name ?? 'Unknown';

        const locale = useI18nStore.getState().locale;
        const systemMsg: ChatMessage = {
          id: generateMessageId(),
          stableId: '',
          senderId: 'system',
          senderName: 'System',
          text: translate(locale, 'system.userLeft', { name: memberName }),
          timestamp: Date.now(),
          isMine: false,
          isSystem: true,
        };

        set((state) => {
          const members = state.members.filter((m) => m.id !== data.id);
          const messages = [...state.messages, systemMsg];

          // Clear typing state for this member
          const typingMembers = new Map(state.typingMembers);
          const handle = typingMembers.get(data.id);
          if (handle) {
            clearTimeout(handle);
            typingMembers.delete(data.id);
          }

          return {
            members,
            messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
            typingMembers,
          };
        });

        // Play leave sound
        if (!get().muted) playLeaveSound();

        // 📚 学习要点: 成员离开时中止相关文件传输
        // 当发送方离开房间时，其所有正在进行的文件传输都无法继续完成。
        // 调用 handleSenderLeft() 将该发送方的所有接收中传输标记为 failed，
        // 让接收方立即看到"发送方已离开，传输中断"的反馈，
        // 而不是等待 60 秒超时才显示失败（更好的用户体验）。
        // 同时释放接收缓冲区内存，防止无用数据占用内存。
        useFileTransferStore.getState().handleSenderLeft(data.id);
        break;
      }

      case MSG_RELAY_MESSAGE: {
        const data = msg.data as RelayMessageData;
        const { roomKey } = get();

        if (!roomKey) break;

        // Decrypt asynchronously
        decryptMessage(roomKey, data.iv, data.ciphertext)
          .then(async (plaintext) => {
            // 📚 学习要点: parseSignedPayload vs parsePayload
            // parseSignedPayload 扩展了 parsePayload，额外提取 sig、type、pubkey 字段。
            // 保持向后兼容：如果明文不是有效 JSON 或缺少 text 字段，
            // 整个明文作为 text 返回（兼容旧客户端），sig 为 undefined → 'no-sig' 状态。
            const parsed = parseSignedPayload(plaintext);
            const { text, reply, sig } = parsed;

            // ─── 公钥广播处理（type="pubkey"）────────────────────────────────
            // 📚 学习要点: 公钥广播的自验证（Self-Verification）
            // 收到公钥广播时，发送方的公钥尚未存储（这正是广播的目的）。
            // 因此使用广播中携带的 pubkey 验证广播本身的 sig（自证明）：
            // 证明发送方确实持有对应的私钥，防止无效公钥被存储。
            // 自验证失败 → 丢弃广播，不存储公钥。
            if (parsed.type === 'pubkey' && parsed.pubkey && parsed.sig) {
              try {
                // Step 1: 解码嵌入的公钥（base64url → 32 字节 Uint8Array）
                const pubkeyBytes = decodePublicKey(parsed.pubkey);

                // Step 2: 导入为 CryptoKey（用于验证签名）
                const importedKey = await importVerifyKey(pubkeyBytes);

                // Step 3: 自验证 — 用嵌入的公钥验证广播本身的签名
                // 构建验证 payload（与发送方签名时相同的结构，不含 sig）
                const verificationPayload: Record<string, unknown> = {
                  type: 'pubkey',
                  text: '',
                  pubkey: parsed.pubkey,
                };
                const signableBytes = computeSignableBytes(verificationPayload);
                const valid = await verifySignature(importedKey, signableBytes, parsed.sig);

                if (!valid) {
                  // 自验证失败 — 丢弃广播，不存储公钥
                  console.warn(
                    `[Security] Public key announcement from ${data.senderName} (${data.senderId}) failed self-verification. Discarding.`
                  );
                  return; // 不添加到消息数组（抑制显示）
                }

                // Step 4: 检查公钥冲突（TOFU key change）
                const { publicKeyMap, members } = get();
                const existingEntry = publicKeyMap.get(data.senderId);

                if (existingEntry) {
                  // 比较原始字节是否相同
                  const isSameKey =
                    existingEntry.raw.length === pubkeyBytes.length &&
                    existingEntry.raw.every((byte, i) => byte === pubkeyBytes[i]);

                  if (!isSameKey) {
                    // 公钥冲突 — 接受新公钥，显示系统警告
                    // 📚 学习要点: TOFU（Trust On First Use）密钥变更处理
                    // 在临时聊天场景中，密钥变更是正常操作（用户刷新页面、网络重连）。
                    // 不像 SSH 那样阻止连接，仅显示警告供用户知晓。
                    const senderMember = members.find((m) => m.id === data.senderId);
                    const senderName = senderMember?.name ?? data.senderName;

                    const warningMsg: ChatMessage = {
                      id: generateMessageId(),
                      stableId: '',
                      senderId: 'system',
                      senderName: 'System',
                      text: `⚠️ ${senderName}'s signing key has changed`,
                      timestamp: Date.now(),
                      isMine: false,
                      isSystem: true,
                    };

                    set((state) => {
                      const messages = [...state.messages, warningMsg];
                      return {
                        messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
                      };
                    });
                  }
                }

                // Step 5: 存储公钥（新增或更新）
                const newEntry: PublicKeyEntry = {
                  raw: pubkeyBytes,
                  cryptoKey: importedKey,
                  firstSeen: Date.now(),
                };

                set((state) => {
                  const updatedMap = new Map(state.publicKeyMap);
                  updatedMap.set(data.senderId, newEntry);
                  return { publicKeyMap: updatedMap };
                });

                // Step 6: 批量验证延迟队列中的待验证消息
                // 收到公钥后，之前因公钥未知而暂存的消息可以立即验证
                const deferredResults = await deferredQueue.processDeferredQueue(
                  data.senderId,
                  importedKey
                );

                if (deferredResults.length > 0) {
                  set((state) => {
                    const updatedMessages = state.messages.map((msg) => {
                      const result = deferredResults.find((r) => r.messageId === msg.id);
                      if (result) {
                        return { ...msg, verificationStatus: result.result };
                      }
                      return msg;
                    });
                    return { messages: updatedMessages };
                  });
                }
              } catch (err) {
                console.warn(
                  `[Security] Failed to process public key announcement from ${data.senderName}:`,
                  err
                );
              }

              // 公钥广播不显示在聊天 UI 中 — 直接返回
              return;
            }

            // ─── 签名验证逻辑 ───────────────────────────────────────────────
            // 📚 学习要点: 签名验证的三种情况
            // 1. sig 存在 + 公钥已知 → 立即验证（使用缓存的 CryptoKey，无重复 import 开销）
            // 2. sig 存在 + 公钥未知 → 加入延迟验证队列（等待公钥广播到达后批量验证）
            // 3. 无 sig → 标记为 'no-sig'（旧客户端或不支持 Ed25519 的浏览器）
            let verificationStatus: ChatMessage['verificationStatus'];

            if (sig) {
              const { publicKeyMap } = get();
              const senderEntry = publicKeyMap.get(data.senderId);

              if (senderEntry) {
                // 公钥已知 — 使用缓存的 CryptoKey 验证签名（无需重新 importVerifyKey）
                // 将明文重新解析为 Record<string, unknown> 以传递给 verifyMessageSignature
                // （verifyMessageSignature 内部会调用 computeSignableBytes 移除 sig 并计算 canonical JSON）
                let rawPayload: Record<string, unknown>;
                try {
                  rawPayload = JSON.parse(plaintext) as Record<string, unknown>;
                } catch {
                  rawPayload = { text: plaintext };
                }
                const result = await verifyMessageSignature(senderEntry.cryptoKey, rawPayload);
                verificationStatus = result;
              } else {
                // 公钥未知 — 延迟验证（消息先显示为 'unknown'，公钥到达后批量更新）
                verificationStatus = 'unknown';
              }
            } else {
              // 无签名 — 向后兼容（旧客户端或 Ed25519 不支持）
              verificationStatus = 'no-sig';
            }

            const chatMsg: ChatMessage = {
              id: generateMessageId(),
              stableId: makeStableId(data.senderId, data.t),
              senderId: data.senderId,
              senderName: data.senderName,
              text,
              timestamp: data.t,
              isMine: false,
              isSystem: false,
              reply,
              verificationStatus,
            };

            // 如果签名存在但公钥未知，加入延迟验证队列
            if (sig && verificationStatus === 'unknown') {
              let rawPayload: Record<string, unknown>;
              try {
                rawPayload = JSON.parse(plaintext) as Record<string, unknown>;
              } catch {
                rawPayload = { text: plaintext };
              }

              const evicted = deferredQueue.add(data.senderId, {
                messageId: chatMsg.id,
                payload: rawPayload,
                sig,
              });

              // 如果队列溢出淘汰了旧消息，将其标记为 'unknown'（已是默认值，无需额外操作）
              if (evicted) {
                // 被淘汰的消息已经在 state 中标记为 'unknown'，此处仅作为文档说明
              }
            }

            set((state) => {
              const messages = [...state.messages, chatMsg];
              return {
                messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
              };
            });

            // Schedule ephemeral removal for received messages
            const { ephemeral } = get();
            if (ephemeral > 0 && !chatMsg.isSystem) {
              scheduleEphemeralRemoval(chatMsg.id, ephemeral);
            }

            // Notification: sound + desktop
            const { muted } = get();
            if (!muted) {
              playNotificationSound();
            }
            if (document.hidden) {
              showDesktopNotification(data.senderName);
            }
          })
          .catch(() => {
            // Decryption failed — show placeholder
            const locale = useI18nStore.getState().locale;
            const errorMsg: ChatMessage = {
              id: generateMessageId(),
              stableId: makeStableId(data.senderId, data.t),
              senderId: data.senderId,
              senderName: data.senderName,
              text: translate(locale, 'system.decryptFailed'),
              timestamp: data.t,
              isMine: false,
              isSystem: false,
            };

            set((state) => {
              const messages = [...state.messages, errorMsg];
              return {
                messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
              };
            });
          });
        break;
      }

      case MSG_RELAY_REACTION: {
        const data = msg.data as RelayReactionData;
        const { roomKey } = get();

        if (!roomKey) break;

        decryptMessage(roomKey, data.iv, data.ciphertext)
          .then((plaintext) => {
            try {
              const { stableId, emoji, action } = JSON.parse(plaintext);
              if (!stableId || !emoji || !action) return;

              set((state) => {
                const reactions = new Map(state.reactions);
                const list = [...(reactions.get(stableId) || [])];

                if (action === 'add') {
                  const existing = list.find((r) => r.emoji === emoji);
                  if (existing) {
                    if (!existing.userIds.includes(data.senderId)) {
                      existing.userIds = [...existing.userIds, data.senderId];
                    }
                  } else {
                    list.push({ emoji, userIds: [data.senderId] });
                  }
                } else if (action === 'remove') {
                  const existing = list.find((r) => r.emoji === emoji);
                  if (existing) {
                    existing.userIds = existing.userIds.filter((id) => id !== data.senderId);
                    if (existing.userIds.length === 0) {
                      const idx = list.indexOf(existing);
                      list.splice(idx, 1);
                    }
                  }
                }

                reactions.set(stableId, list);
                return { reactions };
              });
            } catch {
              // Invalid reaction payload — ignore
            }
          })
          .catch(() => {
            // Decryption failed — ignore
          });
        break;
      }

      case MSG_MEMBER_TYPING: {
        const data = msg.data as MemberTypingData;
        const { roomKey } = get();

        // 📚 学习要点: 加密 Typing 向后兼容策略
        // 接收到的 typing 消息可能有两种格式：
        // 1. 新格式（加密）: {id, iv, ciphertext} — 需要用 Room_Key 解密
        // 2. 旧格式（明文）: {id, typing} — 直接使用 typing 布尔值
        // 通过检测 iv + ciphertext 字段的存在来区分格式。
        // 解密失败时静默忽略（不更新 typing 指示器），避免影响聊天功能。

        // Type assertion for encrypted format detection
        const rawData = msg.data as Record<string, unknown>;

        if (typeof rawData.iv === 'string' && typeof rawData.ciphertext === 'string') {
          // New encrypted format: {id, iv, ciphertext}
          if (!roomKey) break;

          const senderId = rawData.id as string;
          decryptTypingStatus(roomKey, rawData.iv as string, rawData.ciphertext as string)
            .then((typing) => {
              set((state) => {
                const typingMembers = new Map(state.typingMembers);

                if (typing) {
                  const existingHandle = typingMembers.get(senderId);
                  if (existingHandle) clearTimeout(existingHandle);

                  const handle = setTimeout(() => {
                    set((s) => {
                      const updated = new Map(s.typingMembers);
                      updated.delete(senderId);
                      return { typingMembers: updated };
                    });
                  }, TYPING_TIMEOUT_MS) as unknown as number;

                  typingMembers.set(senderId, handle);
                } else {
                  const handle = typingMembers.get(senderId);
                  if (handle) clearTimeout(handle);
                  typingMembers.delete(senderId);
                }

                return { typingMembers };
              });
            })
            .catch(() => {
              // Decryption failed — silently ignore (don't break typing indicator)
            });
        } else if (typeof data.typing === 'boolean') {
          // Old plaintext format: {id, typing} — backward compatibility
          set((state) => {
            const typingMembers = new Map(state.typingMembers);

            if (data.typing) {
              const existingHandle = typingMembers.get(data.id);
              if (existingHandle) clearTimeout(existingHandle);

              const handle = setTimeout(() => {
                set((s) => {
                  const updated = new Map(s.typingMembers);
                  updated.delete(data.id);
                  return { typingMembers: updated };
                });
              }, TYPING_TIMEOUT_MS) as unknown as number;

              typingMembers.set(data.id, handle);
            } else {
              const handle = typingMembers.get(data.id);
              if (handle) clearTimeout(handle);
              typingMembers.delete(data.id);
            }

            return { typingMembers };
          });
        }
        // If neither format matches, silently ignore
        break;
      }

      case MSG_ROOM_CLOSED: {
        // Clear typing timers
        const { typingMembers } = get();
        typingMembers.forEach((handle) => clearTimeout(handle));

        // 📚 学习要点: 房间关闭时中止所有文件传输
        // 房间关闭意味着所有成员都将断开连接，任何进行中的文件传输都无法继续。
        // 必须在清理房间状态之前调用 abortAllTransfers()，
        // 因为 abortAllTransfers() 需要将所有非终态传输标记为 failed 并释放缓冲区内存。
        // 这确保了：
        // 1. 接收方的 chunk 缓冲区被释放（防止内存泄漏）
        // 2. 发送方的发送循环被停止（防止继续发送到已关闭的连接）
        // 3. UI 正确显示传输失败状态（而非永远停留在"传输中"）
        useFileTransferStore.getState().abortAllTransfers();

        // 📚 学习要点: MsgRoomClosed reason 字段区分关闭原因
        // reason="expired" 表示房间因过期被服务器自动销毁，显示专用过期消息。
        // reason 为空或缺失表示常规关闭（所有人离开），显示通用关闭消息。
        // 向后兼容：旧服务器不发送 reason 字段，此时 data 可能为空对象。
        const closedData = msg.data as RoomClosedData | undefined;
        const reason = closedData?.reason ?? '';

        const locale = useI18nStore.getState().locale;
        const systemMsg: ChatMessage = {
          id: generateMessageId(),
          stableId: '',
          senderId: 'system',
          senderName: 'System',
          text: reason === 'expired'
            ? translate(locale, 'system.roomExpired')
            : translate(locale, 'system.roomClosed'),
          timestamp: Date.now(),
          isMine: false,
          isSystem: true,
        };

        // Cross-store coordination: if in a match session, transition matchStore to 'expired'
        // This prevents the UI from staying stuck in 'in-room' after the room is closed by server.
        // Uses 'expired' (not 'timeout') to distinguish from queue timeout state.
        const matchStatus = useMatchStore.getState().status;
        if (matchStatus === 'in-room') {
          useMatchStore.setState({
            status: 'expired',
            matchRoomId: null,
            matchKey: null,
            matchExpiresAt: null,
          });
        }

        // Clear deferred verification queue
        deferredQueue.clear();

        set((state) => ({
          roomId: null,
          roomKey: null,
          shareCode: null,
          members: [],
          hasPassword: false,
          ephemeral: 0,
          expiresAt: 0,
          messages: [...state.messages, systemMsg],
          typingMembers: new Map(),
          replyTo: null,
          reactions: new Map(),
          signingKeyPair: null,
          publicKeyMap: new Map(),
        }));
        break;
      }

      // ===== 文件传输中转消息（Server → Client, 0x1A-0x1E）=====
      // 📚 学习要点: 消息路由委托模式（Message Routing Delegation）
      // chatStore 是所有服务器消息的统一入口点（单一职责：消息分发）。
      // 文件传输消息不在 chatStore 中处理，而是委托给 fileTransferStore.handleFileMessage()。
      // 这种设计的优势：
      // 1. chatStore 保持简洁，只负责路由，不包含文件传输业务逻辑
      // 2. fileTransferStore 独立管理传输状态（缓冲区、进度、超时），与消息数组解耦
      // 3. 可测试性：文件传输逻辑可以独立于 chatStore 进行单元测试
      // 4. 内存隔离：传输状态（可能包含 5MB 缓冲区）不会污染 chatStore 的状态树
      case MSG_RELAY_FILE_META:
      case MSG_RELAY_FILE_CHUNK:
      case MSG_RELAY_FILE_COMPLETE:
      case MSG_RELAY_FILE_CANCEL:
      case MSG_RELAY_FILE_ACK: {
        // 将所有文件传输消息统一委托给 fileTransferStore 处理
        // fileTransferStore.handleFileMessage() 内部会根据 msg.type 进行二次路由：
        // - META → 解密 metadata → 准备接收缓冲区 → 插入聊天占位符
        // - CHUNK → 验证 → 解密 → 存入缓冲区 → 更新进度
        // - COMPLETE → 验证完整性 → 重组文件 → 发送 ACK
        // - CANCEL → 释放缓冲区 → 显示取消信息
        // - ACK → 更新发送方的已送达计数
        useFileTransferStore.getState().handleFileMessage(msg);
        break;
      }

      case MSG_ERROR: {
        const data = msg.data as ErrorData;

        const locale = useI18nStore.getState().locale;
        const errorKeys: Record<string, 'error.E001' | 'error.E002' | 'error.E003' | 'error.E004' | 'error.E005' | 'error.E006' | 'error.E007'> = {
          E001: 'error.E001',
          E002: 'error.E002',
          E003: 'error.E003',
          E004: 'error.E004',
          E005: 'error.E005',
          E006: 'error.E006',
          E007: 'error.E007',
        };

        const key = errorKeys[data.code];
        const text = key ? translate(locale, key) : (data.msg ?? 'Unknown error');

        const errorMsg: ChatMessage = {
          id: generateMessageId(),
          stableId: '',
          senderId: 'system',
          senderName: 'System',
          text,
          timestamp: Date.now(),
          isMine: false,
          isSystem: true,
        };

        set((state) => {
          const messages = [...state.messages, errorMsg];
          return {
            messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
          };
        });
        break;
      }

      // ===== Match 消息（Server → Client, 0x28-0x2F）=====
      // 📚 学习要点: Match 消息路由委托模式
      // 与文件传输相同的「中央路由 + 委托处理」模式：
      // chatStore 检测到 match 范围消息后委托给 matchStore.handleMatchMessage()。
      // matchStore 内部根据 msgType 执行对应的状态机转换。
      default: {
        // Match messages are in the 0x28-0x2F range (server → client)
        if (msg.type >= 0x28 && msg.type <= 0x2f) {
          useMatchStore.getState().handleMatchMessage(msg.type, msg.data);
        }
        break;
      }
    }
  },
}));
