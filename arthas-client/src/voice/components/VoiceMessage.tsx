/**
 * @file VoiceMessage.tsx — 语音消息气泡组件
 *
 * 本文件实现聊天列表中的语音消息气泡，是语音模块的核心展示组件。
 * 它通过 transferId 订阅 voiceStore 和 fileTransferStore 的实时状态，展示：
 * - 发送者名称（接收的消息左对齐时显示）
 * - 语音时长（格式化为 "M:SS"）
 * - 播放/暂停切换按钮（▶️/⏸️）
 * - 播放进度（currentTime / duration）
 * - 接收中状态（进度指示器 + "接收中..."）
 * - 过期状态（Blob 被 LRU 淘汰后显示"语音已过期"）
 * - 解密失败状态（显示"语音解密失败"）
 *
 * 📚 学习要点: 语音气泡 vs 文件卡片的视觉区分
 * 语音消息和文件消息虽然共享传输协议，但 UI 体验完全不同：
 * - 文件卡片：显示文件名、大小、下载按钮（强调"文件"属性）
 * - 语音气泡：显示波形图标、时长、播放按钮（强调"可播放"属性）
 *
 * 视觉区分方式：
 * 1. 不同的背景色（语音用 indigo/purple 色调，文件用 gray）
 * 2. 音频波形占位图标（🎵）替代文件类型图标
 * 3. 播放/暂停按钮替代下载按钮
 * 4. 进度条显示播放进度而非传输进度
 *
 * 📚 学习要点: 组件状态来源
 * VoiceMessage 的状态来自两个 Store：
 * 1. fileTransferStore — 传输状态（receiving/complete/failed）和传输进度
 * 2. voiceStore — 播放状态（playing/paused/idle/expired）和 Blob 缓存
 *
 * 组件通过 Zustand selector 精确订阅所需状态，避免不必要的重渲染。
 * 例如：只订阅特定 transferId 的传输状态和播放状态。
 *
 * @module voice/components/VoiceMessage
 * @see voiceStore.ts — 播放状态管理、LRU 缓存
 * @see fileTransferStore.ts — 传输状态管理
 * @see formatDuration.ts — 时间格式化
 * @see design.md — Voice Bubble 设计
 * @see requirements.md — Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 4.5, 4.7, NFR-11
 */

import { useVoiceStore } from '../voiceStore';
import { useFileTransferStore } from '../../file-transfer/fileTransferStore';
import { formatDuration } from '../formatDuration';
import { useTranslation } from '../../i18n';
import { canPlayVoiceMime, voiceFileExtension } from '../canPlay';

// ============================================================================
// Props 接口
// ============================================================================

/**
 * VoiceMessage 组件的属性接口。
 *
 * 📚 学习要点: 最小化 Props 设计（与 FileMessage 一致）
 * 组件通过 transferId 从 Store 获取动态状态（传输进度、播放状态），
 * 但 duration、senderName、isMine 是消息创建时就确定的静态属性，
 * 从 ChatVoiceMessage 对象中传入更高效（避免额外的 Store 查找）。
 *
 * 为什么 duration 从 props 传入而非从 Store 获取？
 * - duration 在消息创建时就确定了（录音时长），不会变化
 * - fileTransferStore 的 TransferState 不存储 duration（它是通用的文件传输状态）
 * - 从 ChatVoiceMessage.duration 直接传入最简单直接
 */
export interface VoiceMessageProps {
  /** 文件传输的唯一标识符，用于从 Store 中获取传输和播放状态 */
  transferId: string;
  /** 语音时长（秒），从 ChatVoiceMessage.duration 获取 */
  duration: number;
  /** 发送者名称，用于左对齐时显示 */
  senderName: string;
  /** 是否为自己发送的消息（决定对齐方向和背景色） */
  isMine: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 语音消息气泡组件 — 在聊天列表中展示语音消息的播放界面。
 *
 * 📚 学习要点: 组件的多状态渲染策略
 * 语音消息有多种状态，每种状态的 UI 完全不同：
 * 1. receiving — 传输进行中：显示进度条 + "接收中..."
 * 2. failed — 解密/传输失败：显示错误图标 + "语音解密失败"
 * 3. expired — Blob 被 LRU 淘汰：显示灰色 + "语音已过期"
 * 4. idle — 就绪可播放：显示 ▶️ + 时长
 * 5. playing — 正在播放：显示 ⏸️ + 当前进度/总时长
 * 6. paused — 已暂停：显示 ▶️ + 当前进度/总时长
 *
 * 使用条件渲染（if/else）而非 switch 语句，因为状态来自两个不同的 Store，
 * 需要组合判断（传输状态 + 播放状态）。
 *
 * @param props - 组件属性
 * @returns 语音消息气泡 JSX
 *
 * @example
 * ```tsx
 * <VoiceMessage
 *   transferId="V1StGXR8_Z5jdHi6B-myT"
 *   duration={5}
 *   senderName="Alice"
 *   isMine={false}
 * />
 * ```
 */
export function VoiceMessage({ transferId, duration, senderName, isMine }: VoiceMessageProps) {
  const { t } = useTranslation();

  // ─── 订阅 fileTransferStore 的传输状态 ─────────────────────────────
  // 📚 学习要点: 精确 Selector 避免不必要的重渲染
  // 只提取 status 和 receivedChunks/totalChunks（用于进度计算），
  // 而非订阅整个 TransferState 对象。这样只有这些字段变化时才触发重渲染。
  const transferState = useFileTransferStore(
    (state) => state.transfers.get(transferId)
  );

  // ─── 订阅 voiceStore 的播放状态 ───────────────────────────────────
  // 📚 学习要点: 从 playbackStates Map 中获取特定消息的播放状态
  // 如果 Map 中没有该 transferId 的条目，说明该消息尚未被播放过，
  // 默认状态为 idle。
  const playbackState = useVoiceStore(
    (state) => state.playbackStates.get(transferId)
  );

  // 检查 Blob 是否在缓存中（用于判断 expired 状态）
  const hasBlobCached = useVoiceStore(
    (state) => state.blobCache.has(transferId)
  );

  // Blob URL —— 浏览器无法解码时用于提供下载入口
  const blobUrl = useVoiceStore((state) => state.blobCache.get(transferId));

  // 获取播放和暂停 actions
  const playVoice = useVoiceStore((state) => state.playVoice);
  const pauseVoice = useVoiceStore((state) => state.pauseVoice);

  // ─── 派生状态计算 ─────────────────────────────────────────────────
  // 📚 学习要点: 状态优先级判断
  // 多个状态可能同时存在（如传输完成但 Blob 已过期），需要按优先级判断：
  // 1. 传输失败 → 显示解密失败（最高优先级，不可恢复）
  // 2. 正在接收 → 显示进度（传输未完成，其他状态无意义）
  // 3. Blob 过期 → 显示已过期（传输完成但数据已丢失）
  // 4. 播放状态 → 显示播放/暂停/就绪（正常交互状态）
  const isReceiving = transferState &&
    (transferState.status === 'receiving' || transferState.status === 'pending');
  const isFailed = transferState?.status === 'failed';
  const isTransferComplete = transferState?.status === 'complete' || !transferState;

  // 判断是否过期：传输已完成但 Blob 不在缓存中
  const isExpired = isTransferComplete && !hasBlobCached && !isFailed;

  // 📚 学习要点: 格式不兼容是一种独立的失败状态
  // 录制格式由发送端浏览器决定，解码能力由接收端决定，两者可能不匹配
  // （如 Android 录制的 WebM/Opus 在 iOS Safari 上无法解码）。
  // 数据完整、解密成功、Blob 也在缓存里，但就是放不出声音。
  // 如果不单独处理，用户点击播放后没有任何反应，看起来像是应用坏了。
  const mimeType = transferState?.mimeType;
  const isUnsupported =
    isTransferComplete && hasBlobCached && !isFailed && !canPlayVoiceMime(mimeType);

  // 当前播放状态（默认 idle）
  const currentPlaybackState = playbackState?.state ?? 'idle';
  const currentTime = playbackState?.currentTime ?? 0;

  // 传输进度（接收中时使用）
  const transferProgress = transferState && transferState.totalChunks > 0
    ? Math.round((transferState.receivedChunks / transferState.totalChunks) * 100)
    : 0;

  // ─── 事件处理器 ───────────────────────────────────────────────────

  /**
   * 处理播放/暂停按钮点击。
   *
   * 📚 学习要点: 播放切换逻辑
   * - 当前正在播放 → 暂停
   * - 当前暂停或空闲 → 播放（从头或从暂停位置恢复）
   *
   * playVoice 内部实现了单例策略：
   * 如果有其他消息正在播放，会自动停止前一条再播放新的。
   */
  function handlePlayPauseClick(): void {
    if (currentPlaybackState === 'playing') {
      pauseVoice();
    } else {
      playVoice(transferId);
    }
  }

  // ─── 渲染：接收中状态 ─────────────────────────────────────────────
  if (isReceiving) {
    return (
      <div
        className={`
          flex items-center gap-2 px-3 py-2.5 rounded-xl
          ${isMine
            ? 'bg-indigo-900/40 border border-indigo-700/50'
            : 'bg-gray-800 border border-gray-700'
          }
        `}
        role="article"
        aria-label={`${senderName} ${t('voice.receiving')}`}
      >
        {/* 音频波形占位图标 */}
        <span className="text-lg flex-shrink-0" aria-hidden="true">🎵</span>

        <div className="flex-1 min-w-0">
          {/* 接收中文案 */}
          <p className="text-sm text-gray-300">
            {t('voice.receiving')}
          </p>

          {/* 📚 学习要点: 传输进度条
           * 使用 Tailwind 的 w-[N%] 动态宽度来显示进度。
           * 由于 Tailwind 不支持任意百分比的 JIT 类名，
           * 使用 inline style 设置宽度更可靠。
           */}
          <div className="mt-1.5 h-1 w-full bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-300"
              style={{ width: `${transferProgress}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // ─── 渲染：解密失败状态 ───────────────────────────────────────────
  if (isFailed) {
    return (
      <div
        className={`
          flex items-center gap-2 px-3 py-2.5 rounded-xl
          ${isMine
            ? 'bg-red-900/20 border border-red-800/40'
            : 'bg-red-900/20 border border-red-800/40'
          }
        `}
        role="article"
        aria-label={`${senderName} ${t('voice.decryptFailed')}`}
      >
        <span className="text-lg flex-shrink-0" aria-hidden="true">⚠️</span>
        <p className="text-sm text-red-400">
          {t('voice.decryptFailed')}
        </p>
      </div>
    );
  }

  // ─── 渲染：过期状态（Blob 被 LRU 淘汰） ──────────────────────────
  if (isExpired) {
    return (
      <div
        className={`
          flex items-center gap-2 px-3 py-2.5 rounded-xl opacity-60
          ${isMine
            ? 'bg-gray-800/60 border border-gray-700/50'
            : 'bg-gray-800/60 border border-gray-700/50'
          }
        `}
        role="article"
        aria-label={`${senderName} ${t('voice.expired')}`}
      >
        <span className="text-lg flex-shrink-0" aria-hidden="true">🎵</span>
        <p className="text-sm text-gray-500 italic">
          {t('voice.expired')}
        </p>
      </div>
    );
  }

  // ─── 渲染：格式不支持状态 ─────────────────────────────────────────
  // 音频本身完好无损，只是当前浏览器缺少对应的解码器。提供下载入口，
  // 让用户用系统播放器打开（文件名带正确扩展名）。
  if (isUnsupported) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-amber-900/20 border border-amber-800/40"
        role="article"
        aria-label={`${senderName} ${t('voice.unsupported')}`}
      >
        <span className="text-lg flex-shrink-0" aria-hidden="true">🔇</span>

        <div className="flex-1 min-w-0">
          <p className="text-sm text-amber-300">{t('voice.unsupported')}</p>
          {blobUrl && (
            <a
              href={blobUrl}
              download={`voice-${transferId}.${voiceFileExtension(mimeType)}`}
              className="text-xs text-amber-400 underline hover:text-amber-200 transition-colors"
            >
              {t('voice.download')}
            </a>
          )}
        </div>
      </div>
    );
  }

  // ─── 渲染：正常播放状态（idle / playing / paused） ─────────────────
  // 📚 学习要点: 播放状态的 UI 差异
  // - idle: 显示 ▶️ + 总时长（如 "0:05"）
  // - playing: 显示 ⏸️ + 当前进度/总时长（如 "0:02 / 0:05"）
  // - paused: 显示 ▶️ + 当前进度/总时长（如 "0:02 / 0:05"）
  const isPlaying = currentPlaybackState === 'playing';
  const isPaused = currentPlaybackState === 'paused';
  const showProgress = isPlaying || isPaused;

  return (
    <div
      className={`
        flex items-center gap-2.5 px-3 py-2.5 rounded-xl min-w-[160px]
        ${isMine
          ? 'bg-indigo-900/40 border border-indigo-700/50'
          : 'bg-gray-800 border border-gray-700'
        }
      `}
      role="article"
      aria-label={`${senderName} ${t('voice.recording')} ${formatDuration(duration)}`}
    >
      {/* 播放/暂停按钮 */}
      <button
        onClick={handlePlayPauseClick}
        className={`
          w-9 h-9 flex items-center justify-center rounded-full flex-shrink-0
          transition-colors duration-150
          ${isPlaying
            ? 'bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300'
            : 'bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-400'
          }
        `}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        <span className="text-base" aria-hidden="true">
          {isPlaying ? '⏸️' : '▶️'}
        </span>
      </button>

      {/* 音频信息区域 */}
      <div className="flex-1 min-w-0">
        {/* 波形占位符 + 时长 */}
        <div className="flex items-center gap-1.5">
          {/* 📚 学习要点: 音频波形占位符
           * 设计文档中明确说明 MVP 不实现波形可视化（Out of Scope），
           * 使用简单的静态条形图案作为视觉占位符，
           * 让用户一眼识别这是语音消息而非文件消息。
           */}
          <div className="flex items-end gap-px h-4" aria-hidden="true">
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '40%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '70%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '100%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '55%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '80%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '45%' }} />
            <span className={`w-0.5 rounded-full ${isPlaying ? 'bg-indigo-400' : 'bg-gray-500'}`} style={{ height: '65%' }} />
          </div>

          {/* 时长显示 */}
          <span className="text-xs text-gray-400 ml-1">
            {showProgress
              ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
              : formatDuration(duration)
            }
          </span>
        </div>

        {/* 播放进度条（播放/暂停时显示） */}
        {showProgress && (
          <div className="mt-1.5 h-1 w-full bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-150"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
