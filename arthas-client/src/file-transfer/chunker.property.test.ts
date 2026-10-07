/**
 * 属性测试：文件分片与重组的往返正确性（Round-Trip Property Test）。
 *
 * 本文件使用 fast-check 属性测试框架验证 streamChunks 和 reassembleChunks
 * 的核心不变量：对于任意合法大小的文件，分片后重组必须产生字节完全一致的副本。
 *
 * 📚 学习要点: 属性测试 vs 单元测试
 * 单元测试验证特定输入的特定输出（example-based）。
 * 属性测试验证对所有合法输入都成立的通用性质（property-based）。
 * 例如：「对任意 1-5MB 的字节序列，split → reassemble 产生相同字节」
 * 这比手动编写几个固定大小的测试用例覆盖面广得多，
 * 能发现边界条件和意外输入下的 bug。
 *
 * @module file-transfer/chunker.property.test
 * @see chunker.ts — streamChunks, reassembleChunks 实现
 * @see Requirements 2.1, 2.2, 5.3
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { streamChunks, reassembleChunks } from './chunker';
import { CHUNK_SIZE } from './types';

/**
 * 辅助函数：生成指定大小的确定性字节数组。
 *
 * 📚 学习要点: 为什么不使用 crypto.getRandomValues？
 * happy-dom 测试环境中 crypto.getRandomValues 有 65,536 字节的限制。
 * 对于属性测试，我们不需要密码学安全的随机数——
 * fast-check 已经负责生成随机测试输入（文件大小），
 * 文件内容只需要是可区分的字节模式即可验证往返正确性。
 */
function generateTestBuffer(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // 使用可预测但非平凡的模式，便于调试
    buffer[i] = (i * 7 + 13) % 256;
  }
  return buffer;
}

/**
 * **Validates: Requirements 2.1, 2.2, 5.3**
 *
 * Property 1: Chunk split/reassemble round-trip
 * - For any ArrayBuffer (1 to 5,242,880 bytes), split into chunks then reassemble
 *   produces byte-identical copy
 * - All chunks except last are exactly 65,536 bytes
 * - Total chunks equals Math.ceil(size / 65536)
 */
describe('Property: Chunk split/reassemble round-trip', () => {
  it('split then reassemble produces byte-identical copy for any file size', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 📚 学习要点: 智能生成器设计
        // 使用 fc.integer 限制文件大小范围为 1-200,000 字节。
        // 属性测试会运行多次迭代，每次都涉及 File I/O 和 Blob 操作，
        // 因此限制单次迭代的文件大小以保持测试在合理时间内完成。
        // 更大的边界值（如 5MB）通过独立的 example-based 测试覆盖。
        fc.integer({ min: 1, max: 200_000 }),
        async (size) => {
          // 生成确定性字节内容
          const buffer = generateTestBuffer(size);

          // 创建 File 对象（streamChunks 的输入类型）
          const file = new File([buffer as BlobPart], 'test.bin');

          // 收集所有分片
          const chunks: { index: number; data: ArrayBuffer }[] = [];
          for await (const chunk of streamChunks(file)) {
            chunks.push(chunk);
          }

          // 验证分片总数 = Math.ceil(size / CHUNK_SIZE)
          const expectedTotalChunks = Math.ceil(size / CHUNK_SIZE);
          expect(chunks.length).toBe(expectedTotalChunks);

          // 验证所有非最后一片的大小恰好为 CHUNK_SIZE (65536 bytes)
          for (let i = 0; i < chunks.length - 1; i++) {
            expect(chunks[i].data.byteLength).toBe(CHUNK_SIZE);
          }

          // 验证最后一片大小 ≤ CHUNK_SIZE 且 > 0
          const lastChunk = chunks[chunks.length - 1];
          expect(lastChunk.data.byteLength).toBeLessThanOrEqual(CHUNK_SIZE);
          expect(lastChunk.data.byteLength).toBeGreaterThan(0);

          // 验证分片索引连续且从 0 开始
          for (let i = 0; i < chunks.length; i++) {
            expect(chunks[i].index).toBe(i);
          }

          // 将 ArrayBuffer 分片转换为 Uint8Array 用于 reassembleChunks
          const uint8Chunks: (Uint8Array | null)[] = chunks.map(
            (c) => new Uint8Array(c.data)
          );

          // 重组分片
          const reassembled = reassembleChunks(uint8Chunks, 'application/octet-stream');

          // 将 Blob 转换为 ArrayBuffer 进行字节比较
          const reassembledBuffer = new Uint8Array(await reassembled.arrayBuffer());

          // 验证重组后的数据与原始数据字节完全一致
          expect(reassembledBuffer.length).toBe(size);
          expect(reassembledBuffer).toEqual(buffer);
        }
      ),
      { numRuns: 30 }
    );
  }, 30_000); // 30s timeout for property test with multiple async iterations

  it('handles boundary value: exactly 5,242,880 bytes (MAX_FILE_SIZE)', async () => {
    const size = 5_242_880;
    const buffer = generateTestBuffer(size);

    const file = new File([buffer as BlobPart], 'max-size.bin');

    const chunks: { index: number; data: ArrayBuffer }[] = [];
    for await (const chunk of streamChunks(file)) {
      chunks.push(chunk);
    }

    // 5,242,880 / 65,536 = 80 exactly
    expect(chunks.length).toBe(80);

    // 所有 80 片都应该恰好是 CHUNK_SIZE（因为 5MB 能被 64KB 整除）
    for (const chunk of chunks) {
      expect(chunk.data.byteLength).toBe(CHUNK_SIZE);
    }

    // 重组并验证
    const uint8Chunks: (Uint8Array | null)[] = chunks.map(
      (c) => new Uint8Array(c.data)
    );
    const reassembled = reassembleChunks(uint8Chunks, 'application/octet-stream');
    const reassembledBuffer = new Uint8Array(await reassembled.arrayBuffer());

    expect(reassembledBuffer.length).toBe(size);
    expect(reassembledBuffer).toEqual(buffer);
  // 切 5MB 需要 80 次异步 Blob 读取；happy-dom 的 Blob 是纯 JS 实现，
  // 实测约 31s，刚好越过原来的 30s 上限。
  }, 120_000);

  it('handles boundary value: exactly 1 byte (minimum file size)', async () => {
    const buffer = new Uint8Array([42]);
    const file = new File([buffer], 'tiny.bin');

    const chunks: { index: number; data: ArrayBuffer }[] = [];
    for await (const chunk of streamChunks(file)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].data.byteLength).toBe(1);
    expect(chunks[0].index).toBe(0);

    const uint8Chunks: (Uint8Array | null)[] = [new Uint8Array(chunks[0].data)];
    const reassembled = reassembleChunks(uint8Chunks, 'application/octet-stream');
    const reassembledBuffer = new Uint8Array(await reassembled.arrayBuffer());

    expect(reassembledBuffer).toEqual(buffer);
  });

  it('handles boundary value: exactly CHUNK_SIZE bytes (single full chunk)', async () => {
    const buffer = generateTestBuffer(CHUNK_SIZE);
    const file = new File([buffer as BlobPart], 'one-chunk.bin');

    const chunks: { index: number; data: ArrayBuffer }[] = [];
    for await (const chunk of streamChunks(file)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].data.byteLength).toBe(CHUNK_SIZE);

    const uint8Chunks: (Uint8Array | null)[] = [new Uint8Array(chunks[0].data)];
    const reassembled = reassembleChunks(uint8Chunks, 'application/octet-stream');
    const reassembledBuffer = new Uint8Array(await reassembled.arrayBuffer());

    expect(reassembledBuffer).toEqual(buffer);
  });

  it('handles boundary value: CHUNK_SIZE + 1 bytes (two chunks, last is 1 byte)', async () => {
    const size = CHUNK_SIZE + 1;
    const buffer = generateTestBuffer(size);
    const file = new File([buffer as BlobPart], 'boundary.bin');

    const chunks: { index: number; data: ArrayBuffer }[] = [];
    for await (const chunk of streamChunks(file)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0].data.byteLength).toBe(CHUNK_SIZE);
    expect(chunks[1].data.byteLength).toBe(1);

    const uint8Chunks: (Uint8Array | null)[] = chunks.map(
      (c) => new Uint8Array(c.data)
    );
    const reassembled = reassembleChunks(uint8Chunks, 'application/octet-stream');
    const reassembledBuffer = new Uint8Array(await reassembled.arrayBuffer());

    expect(reassembledBuffer).toEqual(buffer);
  });
});
