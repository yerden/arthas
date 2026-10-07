/**
 * @file 语音模块初始化 — 回调注册入口（side-effect module）
 *
 * 本文件负责在应用启动时将语音模块的回调注册到 fileTransferStore。
 * 作为 main.tsx 的 side-effect import 执行（`import './voice/init'`）。
 *
 * 📚 学习要点: 为什么用独立模块而非 voiceStore 内部注册？
 * voiceStore.ts import fileTransferStore → fileTransferStore import ... → 可能形成循环。
 * 独立的 init.ts 打破循环：它 import 两个 store 但不被任何 store import。
 * 依赖方向：init.ts → voiceStore + fileTransferStore（单向，无环）。
 *
 * 📚 学习要点: ES Module 静态 import 语义
 * 静态 `import` 语句在模块加载时执行（声明提升），不受代码位置影响。
 * Zustand store 在模块加载时通过 `create()` 完成初始化，因此 `voice/init.ts`
 * import `fileTransferStore` 时，store 已经存在。不需要 setTimeout 延迟。
 *
 * 📚 学习要点: Side-effect Module 模式
 * 当一个模块被 import 时，其顶层代码会立即执行。
 * 本文件利用这一特性：在模块顶层调用 initVoice()，
 * 使得 `import './voice/init'` 即可完成回调注册，无需调用方显式调用函数。
 * 这是 ES Module 规范中的标准模式，常用于 polyfill 和初始化逻辑。
 *
 * @module voice/init
 * @see voiceStore.ts — registerVoiceBlob 方法（回调的最终消费者）
 * @see fileTransferStore.ts — registerTransferCompleteCallback（注册入口）
 * @see main.tsx — `import './voice/init'`（触发本模块加载）
 */

import { useFileTransferStore } from '../file-transfer/fileTransferStore';
import { useVoiceStore } from './voiceStore';
import { canPlayVoiceMime } from './canPlay';
import { isOggOpus, transcodeOggOpusToWav } from './transcode';

/**
 * 注册语音 Blob，必要时先转码成浏览器能播放的格式。
 *
 * 📚 学习要点: 为什么在接收时转码，而不是播放时？
 * voiceStore.playVoice 是同步的，播放时转码会把它变成异步，连带影响
 * player 的单例播放逻辑和 UI 状态机。接收时转码虽然会处理掉用户可能
 * 永远不播放的消息，但保持了调用链的同步契约，改动面小得多。
 *
 * 失败时一律退回原始 blobUrl —— 此时 VoiceMessage 会显示「无法播放 +
 * 下载」，而不是让消息凭空消失。
 */
async function registerPlayableVoice(
  transferId: string,
  blobUrl: string,
  mimeType: string | undefined
): Promise<void> {
  const store = useVoiceStore.getState();

  // 能原生播放，或不是我们能解码的格式 —— 直接注册原始 Blob
  if (canPlayVoiceMime(mimeType) || !isOggOpus(mimeType)) {
    store.registerVoiceBlob(transferId, blobUrl);
    return;
  }

  try {
    const original = await (await fetch(blobUrl)).blob();
    const wav = await transcodeOggOpusToWav(original);
    if (wav) {
      // voiceStore 负责在 LRU 淘汰时 revoke 它拿到的这个 URL。
      // 原始 blobUrl 由 fileTransferStore 持有，这里不越权回收。
      store.registerVoiceBlob(transferId, URL.createObjectURL(wav));
      return;
    }
  } catch (error) {
    console.warn('[VoiceInit] transcode failed, using original blob:', error);
  }

  store.registerVoiceBlob(transferId, blobUrl);
}

// ============================================================================
// 初始化函数
// ============================================================================

/**
 * 执行语音模块初始化：注册传输完成回调。
 *
 * 当文件传输完成且 metadata.isVoice 为 true 时，
 * 将解密后的 blobUrl 注册到 voiceStore 的 LRU 缓存中，
 * 使语音消息可以被播放。
 *
 * 📚 学习要点: 防御性编程（Defensive Programming）
 * try-catch 包裹整个注册逻辑，确保即使 store 不可用（如测试环境 mock 不完整），
 * 应用也不会崩溃。语音回放功能会降级（无法播放），但其他功能正常运行。
 * console.warn 提供调试线索，帮助开发者定位问题。
 *
 * 📚 学习要点: Guard Clause（卫语句）模式
 * 在函数开头检查前置条件（fileTransferStore 是否可用），
 * 不满足时提前返回。这比嵌套 if-else 更清晰，减少缩进层级，
 * 让"正常路径"代码保持在最外层，提高可读性。
 */
export function initVoice(): void {
  try {
    // Guard: 确保 fileTransferStore 可用
    const fileTransferStore = useFileTransferStore;
    if (!fileTransferStore || typeof fileTransferStore.getState !== 'function') {
      console.warn('[VoiceInit] fileTransferStore is not available, skipping callback registration');
      return;
    }

    fileTransferStore.getState().registerTransferCompleteCallback(
      (transferId: string, blobUrl: string, metadata) => {
        if (metadata.isVoice) {
          void registerPlayableVoice(transferId, blobUrl, metadata.mimeType);
        }
      }
    );
  } catch (error) {
    console.warn('[VoiceInit] Failed to register callback:', error);
  }
}

// ============================================================================
// 向后兼容别名
// ============================================================================

/**
 * initVoice 的别名，保持向后兼容。
 *
 * 📚 学习要点: 为什么保留别名？
 * 旧代码中 voiceStore.ts 导出了 `initVoiceModule` 函数名。
 * 在迁移过程中（task 2.3 清理 voiceStore 旧代码之前），
 * 外部可能仍通过 `initVoiceModule` 引用此功能。
 * 提供别名确保平滑迁移，避免一次性大规模重命名。
 */
export const initVoiceModule = initVoice;

// ============================================================================
// Side-effect: 模块加载时立即执行
// ============================================================================

// 📚 学习要点: 顶层调用确保 import 即初始化
// `import './voice/init'` 在 main.tsx 中执行时，
// 本行代码会立即运行，完成回调注册。
// 无需调用方显式调用 initVoice()，减少遗漏风险。
initVoice();
