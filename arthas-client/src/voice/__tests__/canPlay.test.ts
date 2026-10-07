/**
 * @file canPlay.test.ts — 播放能力探测的单元测试
 *
 * 核心不变量：只有 canPlayType 返回空字符串时才判定为「无法播放」。
 * 'maybe' 必须当作可以播放 —— 浏览器在 MIME 不带 codecs 参数时经常返回
 * 'maybe'，把它当成否定会导致大量可播放的语音被误判为不支持。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { canPlayVoiceMime, voiceFileExtension, resetVoiceSupportCache } from '../canPlay';

/**
 * 模拟一个「可信」的 canPlayType 实现。
 *
 * 对照类型 audio/mpeg 必须返回非空值，否则 canPlay 会判定探针不可信
 * （happy-dom 的默认行为就是对一切返回空字符串），从而一律放行。
 */
function mockCanPlayType(result: string) {
  return vi
    .spyOn(HTMLMediaElement.prototype, 'canPlayType')
    .mockImplementation((type: string) =>
      (type.includes('mpeg') ? 'probably' : result) as CanPlayTypeResult
    );
}

describe('canPlayVoiceMime', () => {
  beforeEach(() => {
    resetVoiceSupportCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats an empty canPlayType result as unsupported', () => {
    mockCanPlayType('');
    expect(canPlayVoiceMime('audio/webm;codecs=opus')).toBe(false);
  });

  it("treats 'maybe' as playable", () => {
    mockCanPlayType('maybe');
    expect(canPlayVoiceMime('audio/mp4')).toBe(true);
  });

  it("treats 'probably' as playable", () => {
    mockCanPlayType('probably');
    expect(canPlayVoiceMime('audio/webm;codecs=opus')).toBe(true);
  });

  // 旧客户端不上报 mimeType。此时不应武断显示「不支持」，
  // 而应让 <audio> 自己尝试，失败了还有 player 的 onError 兜底。
  it.each([undefined, null, ''])('assumes playable when mimeType is %p', (mime) => {
    const spy = mockCanPlayType('');
    expect(canPlayVoiceMime(mime)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches the probe result per MIME type', () => {
    const spy = mockCanPlayType('probably');

    canPlayVoiceMime('audio/webm;codecs=opus');
    canPlayVoiceMime('audio/webm;codecs=opus');
    canPlayVoiceMime('audio/webm;codecs=opus');

    const webmProbes = spy.mock.calls.filter(([type]) =>
      String(type).includes('webm')
    );
    expect(webmProbes).toHaveLength(1);
  });

  it('probes each distinct MIME type separately', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(
      (type: string) => (type.includes('webm') ? '' : 'probably') as CanPlayTypeResult
    );

    expect(canPlayVoiceMime('audio/webm;codecs=opus')).toBe(false);
    expect(canPlayVoiceMime('audio/mp4')).toBe(true);
  });

  // 关键安全属性：探针不可信时必须放行，而不是把所有语音都判为不支持。
  // happy-dom / jsdom 对任何类型都返回空字符串，真实浏览器不会这样。
  it('assumes playable when canPlayType is a stub that rejects everything', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(
      '' as CanPlayTypeResult
    );

    expect(canPlayVoiceMime('audio/webm;codecs=opus')).toBe(true);
    expect(canPlayVoiceMime('audio/mp4')).toBe(true);
  });
});

describe('voiceFileExtension', () => {
  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/mp4', 'm4a'],
    ['audio/mp4;codecs=mp4a.40.2', 'm4a'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/mpeg', 'mp3'],
  ])('maps %s to .%s', (mime, ext) => {
    expect(voiceFileExtension(mime)).toBe(ext);
  });

  it.each([undefined, null, '', 'application/octet-stream'])(
    'falls back to .bin for %p',
    (mime) => {
      expect(voiceFileExtension(mime)).toBe('bin');
    }
  );
});
