/**
 * @file 语音录音引擎 — MediaRecorder API 封装
 *
 * 本文件封装浏览器原生 MediaRecorder API，提供简洁的录音控制接口。
 * 职责：
 * - 管理 MediaStream 生命周期（getUserMedia → stop tracks）
 * - 处理不同浏览器的 MIME 类型支持差异（WebM vs MP4）
 * - 提供 start/stop/cancel/dispose 接口，隐藏事件回调复杂性
 * - 集中处理权限请求和错误
 * - 强制执行 500ms 最短录音和 60s 最长录音限制
 *
 * 📚 学习要点: MediaRecorder API 生命周期
 * MediaRecorder 是浏览器原生的音频/视频录制 API，其生命周期如下：
 * 1. 获取 MediaStream: navigator.mediaDevices.getUserMedia({ audio: true })
 * 2. 创建 MediaRecorder: new MediaRecorder(stream, { mimeType })
 * 3. 开始录制: recorder.start() — 触发 'start' 事件
 * 4. 数据可用: recorder.ondataavailable — 每次有新数据时触发
 * 5. 停止录制: recorder.stop() — 触发最后一次 ondataavailable + 'stop' 事件
 * 6. 释放资源: stream.getTracks().forEach(t => t.stop()) — 释放麦克风
 *
 * 📚 学习要点: 浏览器兼容性
 * - Chrome/Edge/Firefox: 支持 audio/webm;codecs=opus（首选）
 * - Safari 14.1+: 不支持 WebM，但支持 audio/mp4;codecs=opus
 * - Safari < 14.1: 不支持 MediaRecorder（PTT 按钮不渲染）
 * 本模块通过 MIME 类型协商链自动选择最佳格式，对调用方透明。
 *
 * 📚 学习要点: 为什么使用工厂函数而非 class？
 * 项目风格偏好工厂函数 + 闭包模式：
 * 1. 内部状态通过闭包隐藏，外部只能通过返回的接口方法访问
 * 2. 不需要 `this` 绑定（避免事件回调中 this 丢失的经典问题）
 * 3. 返回的对象天然满足接口约束（TypeScript 结构类型系统）
 * 4. 更容易进行单元测试（不需要 mock constructor）
 *
 * @module voice/recorder
 * @see types.ts — RecordingState, RecordingResult
 * @see design.md — Voice Recorder 接口定义
 */

import type { RecordingState, RecordingResult } from './types';
import { translate } from '../i18n';
import { useI18nStore } from '../i18n';
import {
  createOpusEncoder,
  isOpusEncodingSupported,
  OPUS_MIME,
  type OpusEncoderHandle,
} from './opusEncoder';

// ============================================================================
// 常量
// ============================================================================

/**
 * 📚 学习要点: 录音时长限制的设计考量
 * - MIN_DURATION_MS (500ms): 防止误触产生无意义的超短录音。
 *   微信也有类似机制（约 1 秒），我们选择 500ms 作为更宽松的阈值。
 * - MAX_DURATION_MS (60s): 限制单条语音消息大小（60s Opus ≈ 60-240KB）。
 *   超过 60s 的语音应该拆分为多条消息或使用文字。
 *   到达上限时自动停止录音并发送，而非丢弃（用户的录音内容有价值）。
 */
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 60_000;

/**
 * 📚 学习要点: MIME 类型协商链
 * 浏览器对音频编码的支持各不相同。我们按优先级尝试：
 * 1. audio/webm;codecs=opus — Chrome/Firefox/Edge 首选，文件小、质量好
 * 2. audio/mp4;codecs=opus — Safari 14.1+ 的 Opus 容器格式
 * 3. '' (空字符串) — 让浏览器使用默认格式（可能是 audio/webm 或 audio/mp4）
 *
 * MediaRecorder.isTypeSupported() 是静态方法，可在创建实例前检测支持情况。
 * 选择结果在 RecordingResult.mimeType 中返回，让发送端知道实际使用的格式。
 */
const MIME_PREFERENCE_CHAIN: string[] = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=opus',
  '', // 浏览器默认
];

// ============================================================================
// VoiceRecorder 接口
// ============================================================================

/**
 * 语音录音引擎接口。
 *
 * 📚 学习要点: 接口与实现分离
 * VoiceRecorder 接口定义了录音引擎的公共 API。
 * 实际实现通过 createVoiceRecorder() 工厂函数创建。
 * 这种分离允许：
 * 1. 单元测试中轻松创建 mock 实现
 * 2. 未来替换底层实现（如使用 AudioWorklet）而不影响调用方
 * 3. 类型系统确保实现满足接口约束
 */
export interface VoiceRecorder {
  /** 当前录音状态（只读） */
  readonly state: RecordingState;
  /** 开始录音（请求麦克风权限 + 启动 MediaRecorder） */
  start(): Promise<void>;
  /** 停止录音并返回结果（如果时长 >= 500ms），否则返回 null */
  stop(): Promise<RecordingResult | null>;
  /** 取消录音（丢弃数据，释放资源） */
  cancel(): void;
  /** 释放所有资源（停止 MediaStream tracks，防止麦克风指示灯常亮） */
  dispose(): void;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取当前 locale 并翻译 i18n key。
 *
 * 📚 学习要点: 在非 React 上下文中使用 i18n
 * React 组件中使用 useTranslation() hook 获取 t 函数。
 * 但 recorder.ts 是纯逻辑模块（非组件），需要直接访问 Zustand store：
 * useI18nStore.getState().locale 同步获取当前语言设置，
 * 然后调用 translate(locale, key) 获取翻译文本。
 */
function t(key: Parameters<typeof translate>[1]): string {
  const locale = useI18nStore.getState().locale;
  return translate(locale, key);
}

/**
 * 协商最佳 MIME 类型。
 *
 * 📚 学习要点: MediaRecorder.isTypeSupported() 的使用
 * 这是一个静态方法，不需要创建 MediaRecorder 实例即可调用。
 * 它检查浏览器是否支持指定的 MIME 类型作为录制输出格式。
 * 注意：空字符串 '' 表示使用浏览器默认格式，始终"支持"。
 *
 * @returns 选中的 MIME 类型字符串，如果浏览器完全不支持则返回 null
 */
function negotiateMimeType(): string | null {
  for (const mime of MIME_PREFERENCE_CHAIN) {
    // 空字符串表示浏览器默认，始终可用
    if (mime === '' || MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  // 理论上不会到达这里（空字符串兜底），但类型安全需要处理
  return null;
}

/**
 * 释放 MediaStream 的所有 tracks。
 *
 * 📚 学习要点: 为什么必须手动释放 MediaStream tracks？
 * getUserMedia() 返回的 MediaStream 包含活跃的音频 track。
 * 如果不调用 track.stop()，浏览器会保持麦克风占用：
 * - 标签页标题栏显示红色录音图标（Chrome）
 * - 系统托盘显示麦克风正在使用（macOS/Windows）
 * - 其他应用可能无法访问麦克风（独占模式）
 *
 * 必须在所有退出路径中调用此函数：正常停止、取消、错误、组件卸载。
 * 使用 try/finally 模式确保即使发生异常也能释放资源。
 */
function releaseStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建语音录音引擎实例。
 *
 * 📚 学习要点: 工厂函数 + 闭包模式
 * 所有内部状态（stream, recorder, chunks, timers）通过闭包隐藏。
 * 外部只能通过返回的 VoiceRecorder 接口方法访问和修改状态。
 * 这比 class 更安全：
 * - 无法从外部直接修改 _state（没有 public/private 的运行时区别）
 * - 事件回调中不需要 bind(this)（闭包自动捕获变量）
 * - 返回对象的形状由 TypeScript 接口约束
 *
 * @returns VoiceRecorder 实例
 */
export function createVoiceRecorder(): VoiceRecorder {
  // === 内部状态（闭包隐藏） ===
  let _state: RecordingState = 'idle';
  let _stream: MediaStream | null = null;
  let _recorder: MediaRecorder | null = null;
  let _chunks: Blob[] = [];
  let _startTime: number = 0;
  let _maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 📚 学习要点: Promise resolve/reject 的外部化
   * MediaRecorder 的 stop() 是异步的 — 调用 stop() 后，
   * 最后一次 ondataavailable 事件触发，然后 onstop 事件触发。
   * 我们需要在 onstop 回调中 resolve stop() 返回的 Promise。
   *
   * 解决方案：将 Promise 的 resolve 函数保存到闭包变量中，
   * 在 onstop 回调中调用它。这是处理"回调转 Promise"的经典模式。
   */
  let _stopResolve: ((result: RecordingResult | null) => void) | null = null;

  /** WASM Opus 编码器；null 表示走原生 MediaRecorder 回退路径。 */
  let _opus: OpusEncoderHandle | null = null;

  // === 内部方法 ===

  /** 清理所有内部状态和资源 */
  function cleanup(): void {
    if (_maxDurationTimer !== null) {
      clearTimeout(_maxDurationTimer);
      _maxDurationTimer = null;
    }
    if (_opus) {
      _opus.dispose();
      _opus = null;
    }
    releaseStream(_stream);
    _stream = null;
    _recorder = null;
    _chunks = [];
    _startTime = 0;
    _stopResolve = null;
  }

  /**
   * 监听麦克风断开（物理拔出或被系统收回），自动丢弃当前录音。
   * Opus 与 MediaRecorder 两条路径共用。
   */
  function attachMicDisconnectHandler(): void {
    const audioTrack = _stream?.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.onended = () => {
      if (_state === 'recording') {
        cleanup();
        _state = 'idle';
        if (_stopResolve) {
          _stopResolve(null);
          _stopResolve = null;
        }
      }
    };
  }

  /**
   * 到达最大时长后自动停止并发送（而非丢弃）。
   * Opus 与 MediaRecorder 两条路径共用。
   */
  function startMaxDurationTimer(): void {
    _maxDurationTimer = setTimeout(() => {
      _maxDurationTimer = null;
      if (_state === 'recording') {
        performStop();
      }
    }, MAX_DURATION_MS);
  }

  /**
   * Opus 路径的停止逻辑。
   *
   * 与 MediaRecorder 路径保持一致的契约：时长不足 MIN_DURATION_MS 返回 null，
   * 否则返回至少 1 秒的 RecordingResult。编码失败同样返回 null，调用方
   * （voiceStore）据此走「录音失败」提示，而不是发出一条空消息。
   */
  async function performOpusStop(): Promise<RecordingResult | null> {
    const encoder = _opus;
    if (_state !== 'recording' || !encoder || !_stream) {
      return null;
    }

    _state = 'processing';
    if (_maxDurationTimer !== null) {
      clearTimeout(_maxDurationTimer);
      _maxDurationTimer = null;
    }

    const durationMs = Date.now() - _startTime;
    try {
      const blob = await encoder.stop();
      if (durationMs < MIN_DURATION_MS) {
        return null;
      }
      return {
        blob,
        duration: Math.max(Math.round(durationMs / 1000), 1),
        mimeType: OPUS_MIME,
      };
    } catch {
      return null;
    } finally {
      // 先置空再 cleanup：编码器已经停止，避免 cleanup() 重复 dispose。
      _opus = null;
      cleanup();
      _state = 'idle';
    }
  }

  /**
   * 内部停止逻辑 — 被 stop() 和 60s 自动停止共用。
   *
   * 📚 学习要点: 为什么 stop 需要返回 Promise？
   * MediaRecorder.stop() 不是同步完成的：
   * 1. 调用 stop() → MediaRecorder 进入 'inactive' 状态
   * 2. 触发最后一次 ondataavailable（包含剩余缓冲数据）
   * 3. 触发 onstop 事件 — 此时所有数据才完整可用
   *
   * 因此 stop() 返回 Promise，在 onstop 回调中 resolve。
   * 调用方 await stop() 后才能安全使用 RecordingResult。
   */
  function performStop(): Promise<RecordingResult | null> {
    if (_opus) {
      return performOpusStop();
    }
    return new Promise<RecordingResult | null>((resolve) => {
      if (_state !== 'recording' || !_recorder || !_stream) {
        // 非录音状态，直接返回 null
        resolve(null);
        return;
      }

      _state = 'processing';
      _stopResolve = resolve;

      // 清除最大时长定时器（如果是手动停止）
      if (_maxDurationTimer !== null) {
        clearTimeout(_maxDurationTimer);
        _maxDurationTimer = null;
      }

      // 📚 学习要点: MediaRecorder.stop() 触发事件链
      // stop() → ondataavailable(最后一块数据) → onstop(录制完成)
      // 我们在 onstop 中组装 Blob 并 resolve Promise
      _recorder.stop();
    });
  }

  // === 公共接口 ===

  const voiceRecorder: VoiceRecorder = {
    get state(): RecordingState {
      return _state;
    },

    async start(): Promise<void> {
      // 前置条件检查
      if (_state !== 'idle') {
        return;
      }

      // 协商 MIME 类型
      const mimeType = negotiateMimeType();
      if (mimeType === null) {
        throw new Error(t('voice.error.micDenied'));
      }

      _state = 'requesting';

      try {
        /**
         * 📚 学习要点: getUserMedia 约束参数
         * - audio: { channelCount: 1 } — 单声道录音，减小文件体积约 50%
         *   语音消息不需要立体声（不是音乐），单声道完全够用
         * - video: false — 不请求摄像头权限
         *
         * 📚 学习要点: getUserMedia 的权限模型
         * 首次调用时浏览器弹出权限请求弹窗。用户可以：
         * - 允许：Promise resolve，返回 MediaStream
         * - 拒绝：Promise reject，抛出 NotAllowedError
         * - 关闭弹窗：等同于拒绝
         * 用户选择后浏览器会记住决定（除非在隐私模式）。
         * 后续调用如果已有权限，不会再弹窗，直接返回 stream。
         */
        _stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1 },
          video: false,
        });
      } catch (err: unknown) {
        // 📚 学习要点: getUserMedia 错误类型
        // - NotAllowedError: 用户拒绝权限或浏览器策略阻止
        // - NotFoundError: 没有麦克风设备
        // - NotReadableError: 麦克风被其他应用占用
        // 统一显示"权限被拒绝"消息（用户角度都是"无法录音"）
        _state = 'idle';
        cleanup();
        throw new Error(t('voice.error.micDenied'));
      }

      // ─── 优先走 WASM Opus 编码 ──────────────────────────────────────────
      // 📚 学习要点: 为什么统一编码而不是各平台各自为政
      // MediaRecorder 的输出格式由浏览器决定，互不兼容：Chrome/Android 产出
      // WebM/Opus（iOS Safari 无法解码），iOS Safari 产出 MP4/AAC（缺少 AAC
      // 解码器的浏览器无法播放）。统一成 Ogg/Opus 后，接收端只需一种解码器。
      //
      // 任何一步失败都静默回退到下面的 MediaRecorder 路径，也就是本次改动
      // 之前的行为 —— 新增的编码器绝不能让「录不了音」成为可能。
      if (isOpusEncodingSupported()) {
        try {
          const encoder = createOpusEncoder(_stream);
          await encoder.start();
          _opus = encoder;
          _chunks = [];
          _startTime = Date.now();
          attachMicDisconnectHandler();
          _state = 'recording';
          startMaxDurationTimer();
          return;
        } catch {
          if (_opus) {
            _opus.dispose();
            _opus = null;
          }
        }
      }

      try {
        // 创建 MediaRecorder 实例
        const recorderOptions: MediaRecorderOptions = {};
        if (mimeType !== '') {
          recorderOptions.mimeType = mimeType;
        }

        _recorder = new MediaRecorder(_stream, recorderOptions);
        _chunks = [];
        _startTime = Date.now();

        /**
         * 📚 学习要点: ondataavailable 事件
         * 当调用 start() 不带 timeslice 参数时，
         * ondataavailable 只在 stop() 时触发一次（包含完整录音数据）。
         * 如果带 timeslice（如 start(1000)），则每 1000ms 触发一次。
         * 我们不使用 timeslice，因为语音消息是录完后整体发送，不需要流式处理。
         */
        _recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) {
            _chunks.push(event.data);
          }
        };

        /**
         * 📚 学习要点: onstop 事件 — 录制完成的最终回调
         * 此时所有 ondataavailable 已触发完毕，_chunks 包含完整数据。
         * 在这里组装 Blob、计算时长、resolve Promise。
         */
        _recorder.onstop = () => {
          const stopTime = Date.now();
          const durationMs = stopTime - _startTime;
          const actualMimeType = _recorder?.mimeType || mimeType || 'audio/webm';

          // 检查最短录音时长
          if (durationMs < MIN_DURATION_MS) {
            // 📚 学习要点: 必须在 cleanup() 之前保存 resolve 引用
            // cleanup() 会将 _stopResolve 置为 null，如果不先保存引用，
            // Promise 将永远无法 resolve，导致调用方 await 永久挂起。
            const resolve = _stopResolve;
            cleanup();
            _state = 'idle';
            if (resolve) {
              resolve(null);
            }
            return;
          }

          // 组装完整的音频 Blob
          const blob = new Blob(_chunks, { type: actualMimeType });
          const duration = Math.round(durationMs / 1000);

          const result: RecordingResult = {
            blob,
            duration: Math.max(duration, 1), // 至少 1 秒（500ms-999ms 四舍五入为 1）
            mimeType: actualMimeType,
          };

          // 释放资源
          releaseStream(_stream);
          _stream = null;
          _recorder = null;
          _chunks = [];
          _startTime = 0;
          _state = 'idle';

          // Resolve stop() 的 Promise
          if (_stopResolve) {
            _stopResolve(result);
            _stopResolve = null;
          }
        };

        /**
         * 📚 学习要点: onerror 事件 — MediaRecorder 内部错误
         * 极少触发，通常是编码器崩溃或硬件故障。
         * 处理方式：清理资源，回到 idle 状态。
         */
        _recorder.onerror = () => {
          cleanup();
          _state = 'idle';
          if (_stopResolve) {
            _stopResolve(null);
            _stopResolve = null;
          }
        };

        /**
         * 📚 学习要点: MediaStream track 的 ended 事件
         * 当麦克风被物理断开或被系统收回时，track 会触发 'ended' 事件。
         * 我们监听此事件来检测"麦克风断开"场景，自动停止录音。
         */
        attachMicDisconnectHandler();

        // 启动录制
        _recorder.start();
        _state = 'recording';

        /**
         * 📚 学习要点: 60 秒最大录音时长的自动停止
         * 使用 setTimeout 在 60 秒后自动调用 stop()。
         * 这确保了：
         * 1. 用户不会意外录制超长语音（浪费带宽和存储）
         * 2. 到达上限时自动发送（而非丢弃），用户的录音内容有价值
         * 3. 与 Requirements 1.8 一致："60 秒到达时自动停止录音并发送"
         *
         * 注意：如果用户在 60 秒内手动松开 PTT，performStop() 会清除此定时器。
         */
        startMaxDurationTimer();
      } catch (err: unknown) {
        // 📚 学习要点: try/finally 模式的变体 — 为什么这里用 try/catch 而非 try/finally？
        // MediaStream 在录音期间必须保持活跃（MediaRecorder 正在使用它）。
        // 如果使用 try/finally { releaseStream() }，正常路径也会释放 stream，
        // 导致 MediaRecorder 无法录音。
        //
        // 因此采用"所有退出路径都调用 cleanup()"的等效策略：
        // - 创建失败（此 catch）→ cleanup() 释放 stream
        // - 正常停止（onstop 回调）→ releaseStream() 释放 stream
        // - 录音错误（onerror 回调）→ cleanup() 释放 stream
        // - 麦克风断开（track.onended）→ cleanup() 释放 stream
        // - 用户取消（cancel/dispose）→ cleanup() 释放 stream
        //
        // 这确保了 MediaStream tracks 在所有错误路径中都被释放，
        // 防止麦克风指示灯常亮（浏览器标签页显示录音图标）。
        cleanup();
        _state = 'idle';
        throw new Error(t('voice.error.micDenied'));
      }
    },

    async stop(): Promise<RecordingResult | null> {
      if (_state !== 'recording') {
        return null;
      }
      return performStop();
    },

    cancel(): void {
      /**
       * 📚 学习要点: cancel vs stop 的区别
       * - stop(): 停止录音，组装 Blob，返回结果（用于发送）
       * - cancel(): 停止录音，丢弃所有数据，不返回结果
       *
       * cancel 用于以下场景：
       * 1. 用户主动取消（如果 UI 提供取消按钮）
       * 2. 录音时间 < 500ms 时由 voiceStore 调用
       * 3. 组件卸载时清理未完成的录音
       */
      if (_state === 'idle') {
        return;
      }

      // 如果 MediaRecorder 正在录制，先停止它（但不处理数据）
      if (_recorder && _recorder.state === 'recording') {
        // 移除 onstop 回调，防止触发数据处理逻辑
        _recorder.onstop = null;
        _recorder.ondataavailable = null;
        _recorder.stop();
      }

      // 释放所有资源
      cleanup();
      _state = 'idle';
    },

    dispose(): void {
      /**
       * 📚 学习要点: dispose 的职责
       * dispose() 是最终的资源清理方法，确保：
       * 1. MediaStream tracks 被停止（麦克风指示灯熄灭）
       * 2. 定时器被清除（防止内存泄漏）
       * 3. 状态重置为 idle
       *
       * 调用时机：
       * - 用户离开聊天房间
       * - 组件卸载（React useEffect cleanup）
       * - 应用关闭前
       *
       * dispose() 与 cancel() 的区别：
       * cancel() 是用户意图的取消操作（可能之后还会再次录音）
       * dispose() 是生命周期结束的清理（录音引擎不再使用）
       * 实际实现相同，但语义不同，便于代码阅读和维护。
       */
      if (_recorder && _recorder.state === 'recording') {
        _recorder.onstop = null;
        _recorder.ondataavailable = null;
        _recorder.stop();
      }

      cleanup();
      _state = 'idle';
    },
  };

  return voiceRecorder;
}
