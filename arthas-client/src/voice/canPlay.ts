/**
 * @file canPlay.ts — 语音格式播放能力探测
 *
 * 语音消息的容器/编码由录制端浏览器决定（见 recorder.ts 的
 * MIME_PREFERENCE_CHAIN），而解码能力由接收端浏览器决定。两者并不保证一致：
 *
 * - Chrome / Android 录制 audio/webm;codecs=opus — iOS Safari 完全不支持 WebM
 * - iOS Safari 录制 audio/mp4 (AAC) — 部分 Linux 浏览器缺少 AAC 解码器
 *
 * 服务器是零知识中继，看不到明文，因此无法转码：兼容性只能在客户端处理。
 *
 * 本模块不负责修复解码，只负责「提前判断能否解码」，让 UI 可以显示明确的
 * 提示和下载入口，而不是让 <audio> 静默失败（用户点击播放后毫无反应）。
 *
 * @module voice/canPlay
 * @see recorder.ts — 录制端 MIME 协商
 * @see components/VoiceMessage.tsx — 不支持时的降级 UI
 */

/**
 * 探测结果缓存：mimeType → 是否可播放。
 *
 * 📚 学习要点: 为什么要缓存？
 * canPlayVoiceMime 在每次组件渲染时都会被调用，而同一个房间里的语音消息
 * 通常只有一两种 MIME 类型。canPlayType 本身很快，但创建 <audio> 元素并
 * 反复查询没有意义 —— 对同一个 MIME 字符串，结果在整个会话期间不会变化。
 */
const supportCache = new Map<string, boolean>();

/** 复用的探测元素，避免每次查询都创建新的 <audio>。 */
let probe: HTMLAudioElement | null = null;

/**
 * canPlayType 在当前环境下是否可信（null = 尚未判定）。
 *
 * 📚 学习要点: 先验证探针本身，再相信探针结果
 * 并非所有环境都真正实现了 canPlayType：happy-dom / jsdom 等测试环境把它
 * 存根为「对任何类型都返回空字符串」。如果直接相信这个结果，所有语音消息
 * 都会被判定为「无法播放」—— 这比原本的静默失败更糟，因为它会拦下本来
 * 能正常播放的音频。
 *
 * 因此先用一个对照组探测：MP3 几乎被所有真实浏览器支持。如果连它都返回
 * 空字符串，说明 canPlayType 是存根实现，不可信，此时一律按「可播放」处理。
 *
 * 这个设计让失败方向是安全的：宁可放行让 <audio> 自己去试（最差回到原本
 * 的行为），也不要错误地拦截。
 */
let probeTrusted: boolean | null = null;

function isProbeTrustworthy(el: HTMLAudioElement): boolean {
  if (probeTrusted === null) {
    probeTrusted = el.canPlayType('audio/mpeg') !== '';
  }
  return probeTrusted;
}

/**
 * 判断当前浏览器能否播放给定 MIME 类型的语音。
 *
 * 📚 学习要点: canPlayType 的三态返回值
 * HTMLMediaElement.canPlayType() 返回三种值之一：
 * - 'probably' — 很可能可以播放（浏览器对容器和编码都有信心）
 * - 'maybe'    — 可能可以播放（通常是 MIME 未带 codecs 参数，无法确定）
 * - ''         — 确定不能播放
 *
 * 只有空字符串是明确的否定。'maybe' 必须当作可以播放，否则会把大量实际
 * 能播放的音频误判为不支持。
 *
 * @param mimeType - 录制端上报的 MIME 类型（如 'audio/webm;codecs=opus'）
 * @returns true 表示可以尝试播放；false 表示浏览器确定无法解码
 */
export function canPlayVoiceMime(mimeType: string | null | undefined): boolean {
  // 📚 学习要点: 未知类型按「可播放」处理
  // 旧客户端可能不上报 mimeType。此时不应该武断地显示「不支持」——
  // 让 <audio> 元素自己尝试，失败了还有 player.ts 的 onError 兜底。
  if (!mimeType) return true;

  const cached = supportCache.get(mimeType);
  if (cached !== undefined) return cached;

  let playable = true;
  try {
    if (typeof document !== 'undefined') {
      if (!probe) probe = document.createElement('audio');
      // 探针不可信时不下结论，直接按可播放处理（见 probeTrusted）。
      playable = !isProbeTrustworthy(probe) || probe.canPlayType(mimeType) !== '';
    }
  } catch {
    // 探测本身失败（极罕见）时保持乐观，不阻止用户尝试播放。
    playable = true;
  }

  supportCache.set(mimeType, playable);
  return playable;
}

/**
 * 根据 MIME 类型推断下载文件扩展名。
 *
 * 浏览器无法播放时，用户仍然可以把文件下载下来用系统播放器打开，
 * 前提是文件名带正确的扩展名。
 */
export function voiceFileExtension(mimeType: string | null | undefined): string {
  if (!mimeType) return 'bin';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'bin';
}

/** 清空探测缓存。仅供测试使用。 */
export function resetVoiceSupportCache(): void {
  supportCache.clear();
  probe = null;
  probeTrusted = null;
}
