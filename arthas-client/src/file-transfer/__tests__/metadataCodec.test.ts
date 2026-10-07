/**
 * @file metadataCodec.test.ts — metadata 序列化的单元测试
 *
 * 守护一条曾经让图片完全发不出去的性质：加密前的 metadata 必须保持在服务器
 * 的单条消息上限以内。超限的后果不是丢一条消息，而是 gorilla/websocket 直接
 * 关闭连接。
 */
import { describe, it, expect } from 'vitest';
import { encodeThumbnail, serializeMetadata } from '../metadataCodec';
import type { FileMetadata } from '../types';

/** 服务器 SetReadLimit(maxMessageSize)，见 internal/network/client.go。 */
const SERVER_READ_LIMIT = 102400;

function meta(over: Partial<FileMetadata> = {}): FileMetadata {
  return {
    transferId: 'abc123',
    fileName: 'photo.jpg',
    fileSize: 2_000_000,
    mimeType: 'image/jpeg',
    totalChunks: 31,
    ...over,
  } as FileMetadata;
}

describe('encodeThumbnail', () => {
  it('produces a JSON-safe string, not an index-keyed object', () => {
    const encoded = encodeThumbnail(new Uint8Array([1, 2, 3]));

    expect(typeof encoded).toBe('string');
    expect(JSON.stringify({ thumbnail: encoded })).not.toContain('"0":');
  });

  // 这正是原始 bug：JSON.stringify(Uint8Array) 得到 {"0":1,"1":2,...}，
  // 每字节约 11.8 个字符，50KB 的缩略图膨胀到约 590KB。
  it('is dramatically smaller than serializing raw bytes', () => {
    const bytes = new Uint8Array(50 * 1024).fill(200);

    const asBase64 = JSON.stringify({ thumbnail: encodeThumbnail(bytes) }).length;
    const asRawBytes = JSON.stringify({ thumbnail: bytes }).length;

    expect(asRawBytes).toBeGreaterThan(SERVER_READ_LIMIT);
    expect(asBase64).toBeLessThan(SERVER_READ_LIMIT);
    expect(asRawBytes / asBase64).toBeGreaterThan(5);
  });
});

describe('serializeMetadata', () => {
  it('keeps a maximum-size thumbnail under the server read limit', () => {
    const thumbnail = encodeThumbnail(new Uint8Array(50 * 1024).fill(200));

    const { bytes, thumbnailDropped } = serializeMetadata(
      meta({ thumbnail }),
      80 * 1024
    );

    expect(thumbnailDropped).toBe(false);
    expect(bytes.length).toBeLessThan(SERVER_READ_LIMIT);
  });

  it('leaves metadata untouched when it fits', () => {
    const thumbnail = encodeThumbnail(new Uint8Array(1024));
    const { bytes, thumbnailDropped } = serializeMetadata(meta({ thumbnail }), 80 * 1024);

    expect(thumbnailDropped).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(bytes)).thumbnail).toBe(thumbnail);
  });

  // 丢预览图好过丢整张图片：超限会让服务器关闭连接。
  it('drops the thumbnail rather than exceeding the limit', () => {
    const thumbnail = encodeThumbnail(new Uint8Array(50 * 1024).fill(200));

    const { bytes, thumbnailDropped } = serializeMetadata(meta({ thumbnail }), 4096);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));

    expect(thumbnailDropped).toBe(true);
    expect(parsed.thumbnail).toBeUndefined();
    expect(bytes.length).toBeLessThan(4096);
  });

  it('preserves every other field when dropping the thumbnail', () => {
    const thumbnail = encodeThumbnail(new Uint8Array(50 * 1024).fill(200));
    const { bytes } = serializeMetadata(meta({ thumbnail }), 4096);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));

    expect(parsed).toMatchObject({
      transferId: 'abc123',
      fileName: 'photo.jpg',
      fileSize: 2_000_000,
      mimeType: 'image/jpeg',
      totalChunks: 31,
    });
  });

  // 没有缩略图却仍然超限时无能为力，但不能因此丢字段或抛异常。
  it('returns intact metadata when oversized with no thumbnail to drop', () => {
    const { bytes, thumbnailDropped } = serializeMetadata(meta(), 10);

    expect(thumbnailDropped).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(bytes)).transferId).toBe('abc123');
  });
});
