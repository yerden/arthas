/**
 * @file wav.ts — PCM → WAV 容器封装
 *
 * 📚 学习要点: 为什么解码后要重新封装成 WAV，而不是直接用 Web Audio 播放？
 * player.ts 刻意建立在 HTML5 Audio 之上，因为它需要暂停/恢复，而 Web Audio 的
 * AudioBufferSourceNode 是一次性的（见 player.ts 顶部的说明）。
 *
 * 把解码出的 PCM 重新封装成 WAV Blob，就可以继续走现有的 <audio> 播放链路：
 * player.ts、voiceStore 的 LRU 缓存、所有 UI 组件都不需要改动。
 * WAV 是未压缩格式，没有任何浏览器会缺少「解码器」。
 *
 * 代价是内存占用：16 位单声道 48kHz 约 96KB/秒。语音消息很短，且 voiceStore
 * 的 LRU 缓存有条数上限，因此可以接受。
 *
 * @module voice/wav
 */

/** 在 DataView 指定位置写入 ASCII 字符串（WAV 头部的区块标识）。 */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 将解码后的 PCM 声道数据封装为 16 位 WAV Blob。
 *
 * 📚 学习要点: WAV 头部结构（44 字节 Canonical 格式）
 * RIFF 块 (12B) + fmt 子块 (24B) + data 子块头 (8B)，之后是交错排列的采样数据。
 * 所有多字节字段都是小端序 —— 这是 RIFF 格式的规定。
 *
 * @param channelData - 每个声道的 Float32 采样（取值范围 -1..1）
 * @param sampleRate - 采样率（Hz）
 * @returns type 为 'audio/wav' 的 Blob
 */
export function encodeWav(channelData: Float32Array[], sampleRate: number): Blob {
  const numChannels = Math.max(1, channelData.length);
  const numFrames = channelData[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 子块长度（PCM 固定 16）
  view.setUint16(20, 1, true);           // 格式 1 = 未压缩 PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // 字节率
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 📚 学习要点: Float32 → Int16 的非对称缩放
  // Int16 的范围是 -32768..32767（负数比正数多一个）。
  // 负值乘 0x8000、正值乘 0x7FFF，才能既用满量程又不会溢出回绕
  // （-1.0 * 32767 会浪费动态范围，1.0 * 32768 会溢出成最小负数）。
  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const raw = channelData[ch]?.[frame] ?? 0;
      const clamped = Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
