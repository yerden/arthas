/**
 * @file wav.test.ts — WAV 封装的单元测试
 *
 * WAV 头部写错不会抛异常，只会得到一个播放器拒绝打开或播成噪音的文件，
 * 因此这里逐字段断言头部，而不是只检查「有没有产出 Blob」。
 */
import { describe, it, expect } from 'vitest';
import { encodeWav } from '../wav';

async function headerOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe('encodeWav', () => {
  it('writes a canonical 44-byte RIFF/WAVE header', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const view = await headerOf(encodeWav([samples], 48000));

    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(ascii(view, 36, 4)).toBe('data');

    expect(view.getUint32(16, true)).toBe(16); // PCM fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('reports sizes consistent with the payload', async () => {
    const frames = 100;
    const blob = encodeWav([new Float32Array(frames)], 24000);
    const view = await headerOf(blob);

    const dataSize = frames * 2; // mono, 16-bit
    expect(blob.size).toBe(44 + dataSize);
    expect(view.getUint32(40, true)).toBe(dataSize); // data chunk size
    expect(view.getUint32(4, true)).toBe(36 + dataSize); // RIFF size
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
  });

  it('declares audio/wav so <audio> accepts the blob', () => {
    expect(encodeWav([new Float32Array(1)], 48000).type).toBe('audio/wav');
  });

  // 非对称缩放：Int16 的负数比正数多一个，满量程必须分别用 0x8000 / 0x7FFF，
  // 否则 +1.0 会溢出回绕成最小负值（听感上是一声爆音）。
  it('maps full-scale samples without wrapping', async () => {
    const view = await headerOf(encodeWav([new Float32Array([1, -1, 0])], 48000));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const view = await headerOf(encodeWav([new Float32Array([4, -4])], 48000));

    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('interleaves stereo channels frame by frame', async () => {
    const left = new Float32Array([1, 0]);
    const right = new Float32Array([0, -1]);
    const blob = encodeWav([left, right], 48000);
    const view = await headerOf(blob);

    expect(view.getUint16(22, true)).toBe(2); // channel count
    expect(view.getUint16(32, true)).toBe(4); // block align = 2ch * 2 bytes
    expect(view.getInt16(44, true)).toBe(32767); // frame 0 L
    expect(view.getInt16(46, true)).toBe(0); // frame 0 R
    expect(view.getInt16(48, true)).toBe(0); // frame 1 L
    expect(view.getInt16(50, true)).toBe(-32768); // frame 1 R
  });

  it('produces a header-only file for empty input', async () => {
    const blob = encodeWav([new Float32Array(0)], 48000);
    expect(blob.size).toBe(44);
    expect((await headerOf(blob)).getUint32(40, true)).toBe(0);
  });
});
