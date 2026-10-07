/**
 * @file FileMessage.tsx — 文件消息气泡组件
 *
 * 本文件实现聊天列表中的文件消息气泡，是文件传输 UI 的核心展示组件。
 * 它通过 transferId 订阅 fileTransferStore 的实时状态，展示：
 * - 文件类型图标（通过 getFileTypeIcon）
 * - 文件名（超长截断）
 * - 文件大小（人类可读格式）
 * - 传输状态（进度条、完成、失败、取消等）
 * - 操作按钮（取消、下载）
 * - 送达状态（发送方 ACK 计数）
 *
 * 📚 学习要点: Zustand Selector 性能优化
 * 使用 `useFileTransferStore(state => state.transfers.get(transferId))` 订阅单个传输状态。
 * Zustand 的 selector 机制确保只有当该特定传输的状态变化时，组件才会重渲染。
 * 如果使用 `useFileTransferStore(state => state.transfers)` 订阅整个 Map，
 * 则任何传输的状态变化都会触发所有 FileMessage 组件重渲染（O(N) 无效渲染）。
 *
 * 📚 学习要点: Blob URL 内存管理
 * `URL.createObjectURL()` 创建的 Blob URL 会持有对底层 Blob 数据的强引用，
 * 即使 Blob 对象本身已无其他引用，GC 也无法回收其内存。
 * 必须通过 `URL.revokeObjectURL()` 显式释放。
 * 本组件在两个时机释放 Blob URL：
 * 1. 下载完成后（用户已保存文件，Blob URL 不再需要）
 * 2. 组件卸载时（useEffect cleanup，防止内存泄漏）
 *
 * @module file-transfer/components/FileMessage
 * @see fileTransferStore.ts — 传输状态管理
 * @see sanitize.ts — 文件名清理和图标
 * @see requirements.md — Requirements 12.2, 12.3, 12.4, 12.5, 12.6, 6.1, 7.3, 7.7, NFR-7
 */

import { useEffect, useRef, useCallback } from 'react';
import { useFileTransferStore } from '../fileTransferStore';
import { getFileTypeIcon, sanitizeFileName } from '../sanitize';
import { CHUNK_SIZE } from '../types';
import { calculateSpeed, calculateEta } from '../progress';
import { ProgressBar } from './ProgressBar';
import { useTranslation } from '../../i18n';

// ============================================================================
// Props 接口
// ============================================================================

/**
 * FileMessage 组件的属性接口。
 *
 * 📚 学习要点: 最小化 Props 设计
 * 组件只接收 transferId，所有其他数据通过 Zustand selector 从 store 获取。
 * 这种设计的优势：
 * 1. 父组件不需要传递大量 props（减少 prop drilling）
 * 2. 状态变化时只有 FileMessage 自身重渲染（父组件不受影响）
 * 3. 组件可以独立测试（只需 mock store 状态）
 */
export interface FileMessageProps {
  /** 文件传输的唯一标识符，用于从 store 中获取传输状态 */
  transferId: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将字节数格式化为人类可读的文件大小字符串。
 *
 * 📚 学习要点: 二进制 vs 十进制单位
 * 文件大小有两种计量标准：
 * - 二进制（IEC）：1 KiB = 1024 bytes, 1 MiB = 1024 KiB
 * - 十进制（SI）：1 KB = 1000 bytes, 1 MB = 1000 KB
 * 操作系统和大多数应用使用二进制单位但标记为 KB/MB（历史惯例）。
 * 本函数遵循这一惯例：使用 1024 作为进制，但标记为 KB/MB。
 *
 * @param bytes - 文件大小（字节）
 * @returns 格式化后的字符串，如 "1.5 MB"、"320 KB"、"512 B"
 *
 * @example
 * formatFileSize(1536)      // "1.5 KB"
 * formatFileSize(1572864)   // "1.5 MB"
 * formatFileSize(512)       // "512 B"
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 截断文件名，保留扩展名可见。
 *
 * 📚 学习要点: 文件名截断策略
 * 简单地截断到 N 个字符可能会切断扩展名（如 "very-long-name.pd"），
 * 让用户无法识别文件类型。更好的策略是：
 * 1. 如果文件名 ≤ maxLength，直接返回
 * 2. 否则，保留扩展名，截断中间部分，用 "…" 连接
 * 例如："very-long-document-name.pdf" → "very-long-doc…e.pdf"
 *
 * 但为了简洁和一致性，本实现采用更简单的方案：
 * 截断前缀 + "…" + 扩展名（如果有）
 *
 * @param name - 原始文件名
 * @param maxLength - 最大显示长度（默认 20）
 * @returns 截断后的文件名
 *
 * @example
 * truncateFileName("short.txt")                    // "short.txt"
 * truncateFileName("very-long-document-name.pdf")  // "very-long-docume….pdf"
 */
function truncateFileName(name: string, maxLength: number = 20): string {
  if (name.length <= maxLength) {
    return name;
  }

  // 提取扩展名（最后一个 '.' 之后的部分）
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1 || lastDot === 0) {
    // 无扩展名或隐藏文件（如 .gitignore）：直接截断
    return name.slice(0, maxLength - 1) + '…';
  }

  const ext = name.slice(lastDot); // 包含 '.'，如 ".pdf"
  // 如果扩展名本身就很长（>6 字符），直接截断整个名称
  if (ext.length > 6) {
    return name.slice(0, maxLength - 1) + '…';
  }

  // 保留扩展名，截断前缀部分
  const prefixMaxLen = maxLength - ext.length - 1; // -1 for '…'
  return name.slice(0, prefixMaxLen) + '…' + ext;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 文件消息气泡组件 — 在聊天列表中展示文件传输状态。
 *
 * 📚 学习要点: 组件生命周期与资源管理
 * React 组件的 useEffect cleanup 函数在组件卸载时执行，
 * 是释放外部资源（Blob URL、定时器、事件监听器）的最佳时机。
 * 本组件利用 cleanup 确保 Blob URL 在组件卸载时被释放，
 * 防止内存泄漏（即使用户没有点击下载按钮）。
 *
 * @param props - 组件属性，包含 transferId
 * @returns 文件消息气泡 JSX
 *
 * @example
 * ```tsx
 * <FileMessage transferId="V1StGXR8_Z5jdHi6B-myT" />
 * ```
 */
export function FileMessage({ transferId }: FileMessageProps) {
  // ==========================================================================
  // 状态订阅
  // ==========================================================================

  const { t } = useTranslation();

  /**
   * 📚 学习要点: Zustand Selector 的浅比较优化
   * useFileTransferStore 使用 Object.is 比较 selector 返回值。
   * 由于 Map.get() 返回的是对象引用，只有当 set() 创建新的 TransferState 对象时
   * 才会触发重渲染。这正是我们想要的行为：
   * - 其他传输状态变化 → Map 引用变化 → 但 get(transferId) 返回同一对象 → 不重渲染
   * - 本传输状态变化 → 新的 TransferState 对象 → 重渲染
   */
  const transfer = useFileTransferStore(
    (state) => state.transfers.get(transferId)
  );

  // 📚 学习要点: Ref 用于跨渲染周期持有可变值
  // blobUrlRef 持有当前创建的 Blob URL，用于 cleanup 时释放。
  // 使用 ref 而非 state 是因为 Blob URL 的变化不需要触发重渲染。
  const blobUrlRef = useRef<string | null>(null);

  // ==========================================================================
  // Blob URL 清理（组件卸载时释放）
  // ==========================================================================

  useEffect(() => {
    // 📚 学习要点: useEffect cleanup 的执行时机
    // cleanup 函数在以下时机执行：
    // 1. 组件卸载时（unmount）
    // 2. 依赖项变化导致 effect 重新执行前
    // 这里依赖项为空数组 []，所以 cleanup 只在卸载时执行。
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  // 同步 store 中的 blobUrl 到 ref（用于 cleanup）
  useEffect(() => {
    if (transfer?.blobUrl) {
      blobUrlRef.current = transfer.blobUrl;
    }
  }, [transfer?.blobUrl]);

  // ==========================================================================
  // 事件处理器
  // ==========================================================================

  /**
   * 处理取消按钮点击。
   *
   * 📚 学习要点: 为什么使用 getState() 而非 selector？
   * 事件处理器中调用 action 时，使用 `useFileTransferStore.getState().cancelTransfer()`
   * 而非通过 selector 获取 action。原因：
   * 1. Actions 是稳定引用（不会因状态变化而改变），无需订阅
   * 2. getState() 是同步的，适合事件处理器中使用
   * 3. 避免不必要的组件重渲染（如果通过 selector 获取 action）
   */
  const handleCancel = useCallback(() => {
    useFileTransferStore.getState().cancelTransfer(transferId);
  }, [transferId]);

  /**
   * 处理下载按钮点击。
   *
   * 📚 学习要点: 编程式文件下载（Programmatic Download）
   * 浏览器不提供直接的"下载文件"API，但可以通过以下技巧实现：
   * 1. 创建一个隐藏的 <a> 元素
   * 2. 设置 href 为 Blob URL（指向内存中的文件数据）
   * 3. 设置 download 属性为期望的文件名（浏览器会使用此名称保存）
   * 4. 编程式触发 click 事件
   * 5. 移除临时 <a> 元素
   * 6. 释放 Blob URL（文件已保存到磁盘，内存中的数据不再需要）
   *
   * 安全注意事项：
   * - download 属性中的文件名必须经过 sanitizeFileName() 清理
   * - 防止路径遍历攻击（虽然浏览器本身也有保护）
   * - Blob URL 只在同源下有效，不会泄露到外部
   */
  const handleDownload = useCallback(() => {
    if (!transfer || !transfer.blobUrl) return;

    // 清理文件名，防止路径遍历
    const safeName = sanitizeFileName(transfer.fileName);

    // 创建临时 <a> 元素触发下载
    const anchor = document.createElement('a');
    anchor.href = transfer.blobUrl;
    anchor.download = safeName;
    // 📚 学习要点: 为什么需要 appendChild + removeChild？
    // 某些浏览器（特别是 Firefox）要求 <a> 元素在 DOM 中才能触发 click 下载。
    // Chrome 可以在不添加到 DOM 的情况下工作，但为了跨浏览器兼容性，
    // 我们将其临时添加到 body 中。
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    // 下载触发后释放 Blob URL
    // 📚 学习要点: 为什么下载后立即释放？
    // 浏览器在 click 触发后会异步处理下载（复制 Blob 数据到下载管理器）。
    // 使用 setTimeout 确保浏览器有时间开始处理下载，然后再释放 URL。
    // 100ms 的延迟足够浏览器启动下载流程。
    setTimeout(() => {
      if (transfer.blobUrl) {
        URL.revokeObjectURL(transfer.blobUrl);
        blobUrlRef.current = null;
      }
    }, 100);
  }, [transfer]);

  // ==========================================================================
  // 渲染
  // ==========================================================================

  // 防御性检查：如果传输状态不存在，显示占位符
  if (!transfer) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-700 rounded-lg text-gray-400 text-sm">
        <span>📁</span>
        <span>{t('file.loading')}</span>
      </div>
    );
  }

  // 计算派生状态
  const fileIcon = getFileTypeIcon(transfer.mimeType);
  const displayName = truncateFileName(transfer.fileName);
  const displaySize = formatFileSize(transfer.fileSize);
  const isSender = transfer.direction === 'send';
  const isActive = transfer.status === 'sending' || transfer.status === 'receiving';
  const isComplete = transfer.status === 'complete';

  // 计算进度百分比
  const progress = transfer.totalChunks > 0
    ? (transfer.receivedChunks / transfer.totalChunks) * 100
    : 0;

  // 计算已传输字节数（用于 ProgressBar）
  const transferredBytes = transfer.receivedChunks * CHUNK_SIZE;

  // 生成状态文本
  const statusText = getStatusText(transfer.status, isSender, transfer.ackCount, transfer.totalReceivers, t);

  return (
    <div className="max-w-[280px] rounded-lg bg-gray-800 border border-gray-700 overflow-hidden">
      {/* 缩略图预览区域（图片文件且有缩略图时显示） */}
      {transfer.thumbnail && (
        <div
          className="relative cursor-pointer group"
          onClick={isComplete && transfer.blobUrl ? handleDownload : undefined}
          role={isComplete && transfer.blobUrl ? 'button' : undefined}
          aria-label={isComplete ? t('file.clickDownloadImage') : 'Transferring image'}
          tabIndex={isComplete && transfer.blobUrl ? 0 : undefined}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && isComplete && transfer.blobUrl) {
              handleDownload();
            }
          }}
        >
          {/* 📚 学习要点: 内联缩略图预览
           * 缩略图以 data URL 形式存储在 TransferState.thumbnail 中，
           * 可以直接作为 <img> 的 src 使用，无需额外的网络请求。
           * 这实现了 Requirement 8.3：在完整文件传输完成前就显示图片预览。
           */}
          <img
            src={transfer.thumbnail}
            alt={transfer.fileName}
            className="w-full h-auto max-h-[200px] object-cover"
            loading="lazy"
          />
          {/* 传输进行中时显示进度遮罩 */}
          {isActive && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <span className="text-white text-sm font-medium">
                {Math.round(progress)}%
              </span>
            </div>
          )}
          {/* 传输完成时显示下载提示（hover 时显示） */}
          {isComplete && transfer.blobUrl && (
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30
                            flex items-center justify-center transition-colors duration-150">
              <span className="text-white text-sm font-medium opacity-0 group-hover:opacity-100
                              transition-opacity duration-150">
                {t('file.clickDownload')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 文件信息区域 */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* 文件类型图标 */}
        <span className="text-2xl flex-shrink-0" aria-hidden="true">
          {fileIcon}
        </span>

        {/* 文件名和大小 */}
        <div className="flex-1 min-w-0">
          <p
            className="text-sm text-gray-200 font-medium truncate"
            title={transfer.fileName}
          >
            {displayName}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {displaySize}
          </p>
        </div>

        {/* 操作按钮区域 */}
        <div className="flex-shrink-0">
          {/* 发送方：活跃传输时显示取消按钮 */}
          {isSender && isActive && (
            <button
              onClick={handleCancel}
              className="w-8 h-8 flex items-center justify-center rounded-full
                         bg-red-600/20 hover:bg-red-600/40 text-red-400
                         transition-colors duration-150"
              aria-label={t('file.cancel')}
              title={t('file.cancel')}
            >
              ✕
            </button>
          )}

          {/* 接收方/发送方：传输完成时显示下载按钮 */}
          {isComplete && transfer.blobUrl && (
            <button
              onClick={handleDownload}
              className="w-8 h-8 flex items-center justify-center rounded-full
                         bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-400
                         transition-colors duration-150"
              aria-label={t('file.download')}
              title={t('file.download')}
            >
              ⬇️
            </button>
          )}
        </div>
      </div>

      {/* 进度条（活跃传输时显示） */}
      {isActive && (
        <div className="px-3 pb-2">
          <ProgressBar
            progress={progress}
            speed={calculateSpeed(transferredBytes, Date.now() - transfer.startTime)}
            eta={calculateEta(transfer.fileSize - transferredBytes, calculateSpeed(transferredBytes, Date.now() - transfer.startTime))}
          />
        </div>
      )}

      {/* 状态栏 */}
      <div className="px-3 pb-2">
        {/* 📚 学习要点: aria-live="polite" 无障碍播报
         * aria-live="polite" 告诉屏幕阅读器：当此区域内容变化时，
         * 等待当前播报完成后再播报新内容（不打断用户）。
         * 这确保了视障用户能感知传输状态的变化（进度更新、完成、失败等）。
         * "polite" vs "assertive"：
         * - polite：等待当前播报完成（适合非紧急状态更新）
         * - assertive：立即打断当前播报（适合紧急错误通知）
         * 文件传输状态变化不是紧急事件，使用 polite 更合适。
         */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="text-xs"
        >
          {/* 状态文本 */}
          <span className={getStatusColorClass(transfer.status)}>
            {statusText}
          </span>

          {/* 发送方：已送达计数 */}
          {isSender && isComplete && transfer.totalReceivers > 0 && (
            <span className="text-gray-400 ml-2">
              {t('file.delivered', { count: transfer.ackCount, total: transfer.totalReceivers })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 辅助渲染函数
// ============================================================================

/**
 * 根据传输状态生成用户可读的状态文本。
 *
 * @param status - 当前传输状态
 * @param isSender - 是否为发送方
 * @param ackCount - 已确认接收的人数
 * @param totalReceivers - 总接收人数
 * @param t - 翻译函数
 * @returns 状态文本字符串
 */
function getStatusText(
  status: string,
  isSender: boolean,
  _ackCount: number,
  totalReceivers: number,
  t: (key: import('../../i18n').TranslationKey, params?: Record<string, string | number>) => string
): string {
  switch (status) {
    case 'pending':
      return isSender ? t('file.status.pending.send') : t('file.status.pending.receive');
    case 'sending':
      return t('file.status.sending');
    case 'receiving':
      return t('file.status.receiving');
    case 'complete':
      if (isSender && totalReceivers > 0) {
        return t('file.status.complete');
      }
      return t('file.status.complete');
    case 'failed':
      return t('file.status.failed');
    case 'cancelled':
      return isSender ? t('file.status.cancelled') : t('file.status.senderCancelled');
    default:
      return '';
  }
}

/**
 * 根据传输状态返回对应的 Tailwind 颜色类名。
 *
 * 📚 学习要点: 状态 → 颜色映射的语义化设计
 * - 绿色：成功/完成（正面反馈）
 * - 红色：失败/错误（需要注意）
 * - 黄色：取消/警告（中性偏负面）
 * - 灰色：等待/进行中（中性）
 * 这种颜色语义在全球 UI 设计中是通用的，用户无需学习即可理解。
 *
 * @param status - 传输状态
 * @returns Tailwind CSS 颜色类名
 */
function getStatusColorClass(status: string): string {
  switch (status) {
    case 'complete':
      return 'text-green-400';
    case 'failed':
      return 'text-red-400';
    case 'cancelled':
      return 'text-yellow-400';
    case 'pending':
    case 'sending':
    case 'receiving':
    default:
      return 'text-gray-400';
  }
}
