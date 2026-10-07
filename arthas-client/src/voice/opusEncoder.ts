/**
 * @file opusEncoder.ts — 统一的 Ogg/Opus 录音编码
 *
 * 📚 学习要点: 为什么不直接用 MediaRecorder？
 * MediaRecorder 的输出格式由浏览器决定，各平台互不兼容：
 * Chrome/Android 产出 WebM/Opus（iOS Safari 完全无法解码），
 * iOS Safari 产出 MP4/AAC（缺少 AAC 解码器的浏览器无法播放）。
 *
 * 用 WebAssembly 版 libopus 自己编码，可以让所有平台产出同一种格式
 * （Ogg/Opus）。这样接收端只需要一种解码器就能覆盖全部来源 —— 这正是
 * 「统一编码」相比「为每种格式各加一个解码器」的价值所在。
 *
 * 服务器是零知识中继，看不到明文，无法转码，因此兼容性只能在客户端解决。
 *
 * 📚 学习要点: 为什么传 sourceNode 而不是让库自己取流？
 * opus-recorder 可以自己调用 getUserMedia，但 recorder.ts 已经有一套完整的
 * 权限请求、错误分类和麦克风断开处理逻辑。传入 sourceNode 可以让它继续持有
 * MediaStream，本模块只负责「编码」这一件事，改动面最小。
 * 代价是 AudioContext 的生命周期需要本模块自己管理。
 *
 * @module voice/opusEncoder
 * @see recorder.ts — 录音状态机（调用方）
 * @see transcode.ts — 接收端的解码
 */
import Recorder from 'opus-recorder';
import encoderPath from 'opus-recorder/dist/encoderWorker.min.js?url';

/** 本项目统一的语音编码格式。 */
export const OPUS_MIME = 'audio/ogg;codecs=opus';

/** stop() 等待编码器吐出最后数据的上限，超时视为失败并回退。 */
const STOP_TIMEOUT_MS = 5000;

type AudioContextCtor = typeof AudioContext;

/** Safari 旧版本只有带前缀的实现。 */
function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 当前环境是否支持 Opus 编码。
 *
 * 任何一个前置条件不满足都返回 false，调用方会回退到原生 MediaRecorder，
 * 也就是本次改动之前的行为 —— 失败方向始终是「退回旧路径」而非「录不了音」。
 */
export function isOpusEncodingSupported(): boolean {
  try {
    if (!getAudioContextCtor()) return false;
    return typeof Recorder?.isRecordingSupported === 'function'
      && Boolean(Recorder.isRecordingSupported());
  } catch {
    return false;
  }
}

/** 编码器句柄，生命周期由 recorder.ts 的状态机驱动。 */
export interface OpusEncoderHandle {
  /** 启动编码。失败时 reject，调用方据此回退到 MediaRecorder。 */
  start(): Promise<void>;
  /** 停止并返回完整的 Ogg/Opus Blob。 */
  stop(): Promise<Blob>;
  /** 异常路径下释放资源（不产出数据）。 */
  dispose(): void;
}

/**
 * 基于已有的 MediaStream 创建一个 Opus 编码器。
 *
 * @param stream - 调用方持有的麦克风流；本模块不会关闭它
 */
export function createOpusEncoder(stream: MediaStream): OpusEncoderHandle {
  const Ctor = getAudioContextCtor();
  if (!Ctor) throw new Error('AudioContext unavailable');

  const audioContext = new Ctor();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const pages: Uint8Array[] = [];
  let settled = false;

  const recorder = new Recorder({
    encoderPath,
    sourceNode,
    numberOfChannels: 1,
    encoderApplication: 2048, // VOIP：针对语音优化，而非音乐
    encoderSampleRate: 48000,
    encoderBitRate: 24000, // 单声道语音足够清晰，约 3KB/秒
    streamPages: false, // 只在 stop() 时一次性拿到完整文件
  });

  recorder.ondataavailable = (page: Uint8Array) => {
    pages.push(page);
  };

  function closeContext(): void {
    // close() 在部分浏览器上返回 Promise，在旧 Safari 上可能抛错，一律吞掉：
    // 这里是尽力释放资源，失败不影响录音结果。
    try {
      void audioContext.close();
    } catch {
      /* ignore */
    }
  }

  return {
    async start(): Promise<void> {
      // 📚 学习要点: iOS 必须在用户手势中 resume AudioContext
      // 自动播放策略会让 AudioContext 以 'suspended' 状态创建，
      // 不 resume 的话采集到的全是静音。PTT 按下本身就是用户手势。
      try {
        await audioContext.resume();
      } catch {
        /* 某些浏览器上 resume() 不可用或无需调用 */
      }
      await recorder.start();
    },

    stop(): Promise<Blob> {
      return new Promise<Blob>((resolve, reject) => {
        // 编码器 worker 卡死时不能让 await 永久挂起 —— PTT 松开后
        // UI 会一直停在 processing 状态。
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          closeContext();
          reject(new Error('opus encoder timed out'));
        }, STOP_TIMEOUT_MS);

        recorder.onstop = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          closeContext();

          const total = pages.reduce((n, p) => n + p.length, 0);
          if (total === 0) {
            reject(new Error('opus encoder produced no data'));
            return;
          }
          resolve(new Blob(pages as BlobPart[], { type: OPUS_MIME }));
        };

        try {
          void recorder.stop();
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            closeContext();
            reject(err instanceof Error ? err : new Error('opus encoder stop failed'));
          }
        }
      });
    },

    dispose(): void {
      settled = true;
      try {
        recorder.close();
      } catch {
        /* worker 可能已经终止 */
      }
      closeContext();
    },
  };
}
