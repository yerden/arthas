/**
 * @file metadataCodec.ts — 文件 metadata 的序列化
 *
 * 📚 学习要点: JSON 没有二进制类型
 * metadata 在加密前要走 JSON.stringify，而 JSON 规范里没有字节数组。
 * 把 Uint8Array 直接塞进去不会报错，但也不会得到数组 —— 得到的是一个按下标
 * 建键的对象：
 *
 *   JSON.stringify(new Uint8Array([1, 2, 3]))  →  {"0":1,"1":2,"2":3}
 *
 * 每个字节平均要花掉约 11.8 个字符。50KB 的缩略图会膨胀到约 590KB。
 *
 * 这一点之所以致命，是因为服务器对单条消息设了 100KB 的 SetReadLimit，
 * 而 gorilla/websocket 在超限时会直接关闭连接，不是丢弃这一条。于是：
 * 带缩略图的图片根本发不出去，发送方只看到「Delivered 0/1」。
 * 实测约 8.5KB 以上的缩略图就会超限，所以现象看起来时灵时不灵。
 *
 * base64 的膨胀率只有 1.33 倍，50KB → 约 68KB，可以安全通过。
 *
 * 本模块不 import 任何 store，保持可独立测试。
 *
 * @module file-transfer/metadataCodec
 */
import type { FileMetadata } from './types';
import { toBase64Url } from '../crypto/utils';

/** 把缩略图字节编码为可放进 JSON 的字符串。 */
export function encodeThumbnail(bytes: Uint8Array): string {
  // slice() 复制一份，避免 byteOffset 非零的视图取 .buffer 时取到整块内存。
  return toBase64Url(bytes.slice().buffer as ArrayBuffer);
}

export interface SerializedMetadata {
  bytes: Uint8Array<ArrayBuffer>;
  /** 是否因为超限而丢弃了缩略图。 */
  thumbnailDropped: boolean;
}

/**
 * 序列化 metadata，必要时丢弃缩略图以满足大小上限。
 *
 * 📚 学习要点: 宁可丢预览图，也不要丢整张图片
 * 缩略图是 metadata 中唯一可能很大的字段。超限时去掉它重新序列化，
 * 用户失去的只是预览，文件本身照常传输 —— 而超限的后果是连接被关闭。
 */
export function serializeMetadata(
  metadata: FileMetadata,
  maxBytes: number
): SerializedMetadata {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify(metadata));

  if (bytes.length <= maxBytes || !metadata.thumbnail) {
    return { bytes, thumbnailDropped: false };
  }

  const { thumbnail: _oversized, ...withoutThumbnail } = metadata;
  return {
    bytes: encoder.encode(JSON.stringify(withoutThumbnail)),
    thumbnailDropped: true,
  };
}
