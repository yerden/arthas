/**
 * @file transcode.ts — 接收端的 Opus → WAV 转码
 *
 * 📚 学习要点: 为什么转成 WAV 而不是直接播放解码后的 PCM？
 * 见 wav.ts：player.ts 依赖 HTML5 Audio 的暂停/恢复能力，改用 Web Audio
 * 需要重写整个播放状态机。解码后重新封装成 WAV Blob，就能直接复用现有的
 * <audio> 链路 —— player.ts、LRU 缓存和 UI 全部不用改。
 *
 * 📚 学习要点: 只处理 Ogg/Opus
 * 本项目发送端统一产出 Ogg/Opus（见 opusEncoder.ts），所以一个解码器就够了。
 * 老客户端发来的 WebM/Opus 和 MP4/AAC 不在处理范围内：
 * - WebM/Opus 需要额外的 WebM 解复用器
 * - MP4/AAC 需要 AAC 解码器
 * 这些历史消息会落到 canPlay.ts 的「无法播放」分支，显示下载入口。
 *
 * @module voice/transcode
 * @see wav.ts — PCM 封装
 * @see canPlay.ts — 判断是否需要转码
 */
import { encodeWav } from './wav';

/** 判断是否是本模块能够解码的 Ogg/Opus。 */
export function isOggOpus(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  return lower.includes('ogg') && lower.includes('opus');
}

/**
 * 将 Ogg/Opus 音频解码并重新封装为 WAV。
 *
 * 📚 学习要点: 解码器按需加载
 * 动态 import 让 ~117KB 的 wasm 解码器只在真正需要转码时才下载 ——
 * 大多数设备能原生播放自己收到的格式，根本不会走到这里。
 *
 * @returns 可直接播放的 WAV Blob；无法解码时返回 null（调用方保留原始 Blob）
 */
export async function transcodeOggOpusToWav(blob: Blob): Promise<Blob | null> {
  let decoder: { ready: Promise<void>; free: () => void;
                 decodeFile: (d: Uint8Array) => Promise<{ channelData: Float32Array[]; sampleRate: number }> } | null = null;
  try {
    const { OggOpusDecoder } = await import('ogg-opus-decoder');
    decoder = new OggOpusDecoder();
    await decoder.ready;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { channelData, sampleRate } = await decoder.decodeFile(bytes);

    if (!channelData.length || !channelData[0]?.length) return null;
    return encodeWav(channelData, sampleRate);
  } catch {
    // 解码失败不应该让消息彻底消失：返回 null，调用方保留原始 Blob，
    // UI 退回到「无法播放 + 下载」的提示。
    return null;
  } finally {
    try {
      decoder?.free();
    } catch {
      /* ignore */
    }
  }
}
