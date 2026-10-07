/**
 * @file DropZone.tsx — 拖拽上传覆盖层 + 剪贴板粘贴处理
 *
 * 本文件包含两个核心功能：
 * 1. DropZone 组件：包裹聊天区域，在用户拖拽文件时显示全屏覆盖层
 * 2. useClipboardPaste Hook：监听粘贴事件，支持从剪贴板粘贴图片
 *
 * 📚 学习要点: HTML5 Drag and Drop API
 * 浏览器提供了原生的拖拽 API，核心事件流程：
 * 1. dragenter — 拖拽物进入目标区域（显示覆盖层）
 * 2. dragover — 拖拽物在目标区域上方移动（必须 preventDefault 才能允许 drop）
 * 3. dragleave — 拖拽物离开目标区域（隐藏覆盖层）
 * 4. drop — 用户释放拖拽物（获取文件并处理）
 *
 * 关键陷阱：
 * - dragover 必须调用 e.preventDefault()，否则浏览器不允许 drop
 * - dragenter/dragleave 会在子元素边界触发（需要计数器或 contains 检查）
 * - 移动设备不支持 drag-and-drop（需要检测并禁用）
 *
 * 📚 学习要点: 触摸设备检测
 * 使用 `'ontouchstart' in window` 检测设备是否支持触摸。
 * 这不是完美的检测方法（某些笔记本同时支持触摸和鼠标），
 * 但对于「是否显示拖拽功能」的决策来说足够准确：
 * - 纯触摸设备（手机/平板）：不支持 drag-and-drop，禁用相关监听
 * - 桌面设备（含触摸屏笔记本）：支持 drag-and-drop，启用监听
 *
 * @module file-transfer/components/DropZone
 * @see requirements.md — Requirements 1.6, 1.7, 12.7, 12.8, NFR-12
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useFileTransferStore, getLargeRoomWarning } from '../fileTransferStore';
import { useTranslation } from '../../i18n';

// ============================================================================
// 触摸设备检测
// ============================================================================

/**
 * 检测当前设备是否为触摸设备。
 *
 * 📚 学习要点: 为什么在模块级别检测而非组件内？
 * 设备类型在页面生命周期内不会改变（手机不会突然变成桌面电脑），
 * 因此只需检测一次，存储为模块级常量。
 * 这避免了每次组件渲染时重复检测的开销。
 *
 * 注意：此检测在 SSR 环境下会失败（window 不存在），
 * 但 Arthas 是纯客户端应用（SPA），不存在 SSR 场景。
 */
const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window;

// ============================================================================
// DropZone 组件
// ============================================================================

/** DropZone 组件的 Props */
interface DropZoneProps {
  /** 子元素（通常是聊天区域的内容） */
  children: ReactNode;
}

/**
 * 拖拽上传覆盖层组件 — 包裹聊天区域，在拖拽文件时显示全屏覆盖层。
 *
 * 📚 学习要点: 包装器组件模式（Wrapper Component Pattern）
 * DropZone 不改变子元素的渲染，只是在其上方叠加一个条件显示的覆盖层。
 * 这种模式的优势：
 * - 不侵入现有组件结构（MessageList 等无需修改）
 * - 覆盖层的显示/隐藏逻辑完全封装在 DropZone 内部
 * - 可以轻松添加/移除拖拽功能，不影响其他代码
 *
 * 使用方式：
 * ```tsx
 * <DropZone>
 *   <MessageList ... />
 *   <MessageInput />
 * </DropZone>
 * ```
 *
 * @see requirements.md — Requirement 1.7, 12.7
 */
export function DropZone({ children }: DropZoneProps) {
  const { t } = useTranslation();
  /**
   * 📚 学习要点: dragCounter 解决子元素边界问题
   * 当拖拽物经过子元素边界时，会触发 dragleave + dragenter 事件对。
   * 如果只用 boolean 状态，会导致覆盖层闪烁（leave → 隐藏 → enter → 显示）。
   *
   * 解决方案：使用计数器（dragCounter）：
   * - dragenter: counter++，如果 counter > 0 显示覆盖层
   * - dragleave: counter--，如果 counter === 0 隐藏覆盖层
   * - drop: counter = 0，隐藏覆盖层
   *
   * 这样只有当拖拽物真正离开整个 DropZone 区域时，counter 才会归零。
   */
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  /**
   * 处理 dragenter 事件：拖拽物进入区域。
   */
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current++;
    // 只有当拖拽内容包含文件时才显示覆盖层
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  /**
   * 处理 dragover 事件：拖拽物在区域上方移动。
   *
   * 📚 学习要点: 为什么必须 preventDefault？
   * 浏览器默认行为是不允许 drop（会打开文件或导航到文件 URL）。
   * 必须在 dragover 事件中调用 preventDefault() 来告诉浏览器：
   * "这个区域接受 drop 操作，不要执行默认行为"。
   * 如果不调用，drop 事件将不会触发。
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /**
   * 处理 dragleave 事件：拖拽物离开区域。
   */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  /**
   * 处理 drop 事件：用户释放拖拽物。
   *
   * 📚 学习要点: DataTransfer API
   * drop 事件的 `e.dataTransfer.files` 包含用户拖拽的文件列表。
   * 这是一个 FileList 对象（类数组），可以通过索引访问每个 File。
   * 我们遍历所有文件，逐个调用 initiateTransfer 发起传输。
   *
   * 注意：一次拖拽可能包含多个文件，每个文件独立排队传输。
   */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 重置拖拽状态
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // 大房间警告检查（只在第一个文件时检查一次）
    const warning = getLargeRoomWarning();
    if (warning) {
      const confirmed = window.confirm(warning);
      if (!confirmed) return;
    }

    // 逐个文件发起传输
    const { initiateTransfer } = useFileTransferStore.getState();
    for (let i = 0; i < files.length; i++) {
      initiateTransfer(files[i]);
    }
  }, []);

  // 📚 学习要点: 触摸设备不渲染拖拽监听器
  // 在触摸设备上，drag-and-drop API 不可用（或行为不一致）。
  // 直接跳过事件监听，避免不必要的性能开销和潜在的交互冲突。
  // 触摸设备用户通过 FileAttachButton 选择文件。
  // NOTE: the wrapper div must be kept even on touch devices. The parent
  // (ChatRoom's `flex flex-1 overflow-hidden`) is a flex ROW, so without this
  // `flex-col` container the message list, typing indicator and input get laid
  // out side by side instead of stacked -- the input lands to the right of the
  // messages. Only the drag handlers are skipped here, which is the point.
  if (isTouchDevice) {
    return <div className="relative flex-1 flex flex-col overflow-hidden">{children}</div>;
  }

  return (
    <div
      className="relative flex-1 flex flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}

      {/*
        📚 学习要点: 覆盖层 UI 设计
        - fixed/absolute 定位覆盖整个拖拽区域
        - 半透明背景（bg-indigo-900/70）提供视觉反馈但不完全遮挡内容
        - pointer-events-none 在隐藏时不拦截鼠标事件
        - transition 提供平滑的显示/隐藏动画
        - z-50 确保覆盖层在所有内容之上
        - border-dashed 虚线边框是拖拽区域的经典视觉暗示
      */}
      {isDragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-indigo-900/70 border-2 border-dashed border-indigo-400 rounded-lg backdrop-blur-sm"
          aria-label={t('file.drop.title')}
        >
          <div className="text-center">
            <span className="text-4xl block mb-2">📁</span>
            <p className="text-lg font-medium text-indigo-200">
              {t('file.drop.title')}
            </p>
            <p className="text-sm text-indigo-300/70 mt-1">
              {t('file.drop.subtitle')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// useClipboardPaste Hook
// ============================================================================

/**
 * 剪贴板粘贴 Hook — 监听 paste 事件，支持从剪贴板粘贴图片文件。
 *
 * 📚 学习要点: Clipboard API 与 paste 事件
 * 当用户按下 Ctrl+V / Cmd+V 时，浏览器触发 paste 事件。
 * 事件对象的 `clipboardData` 属性包含剪贴板内容：
 * - `clipboardData.files`: 如果剪贴板包含文件（如截图），这里有 FileList
 * - `clipboardData.items`: 更底层的 API，可以区分文件类型
 *
 * 使用场景：
 * - 用户截图后直接 Ctrl+V 粘贴到聊天窗口
 * - 用户从其他应用复制图片后粘贴
 *
 * 限制：
 * - 只处理图片类型（image/*），文本粘贴由 input 元素自行处理
 * - 粘贴的图片命名为 `clipboard-{timestamp}.png`
 *
 * 📚 学习要点: 为什么只支持图片粘贴？
 * 1. 剪贴板中的非图片文件（如复制的文件路径）无法通过 paste 事件获取实际文件内容
 * 2. 文本粘贴应该正常插入到输入框（不应被拦截为文件传输）
 * 3. 图片是最常见的剪贴板文件类型（截图、复制的图片）
 *
 * @param containerRef - 监听 paste 事件的容器元素引用
 *
 * @example
 * ```tsx
 * function ChatArea() {
 *   const containerRef = useRef<HTMLDivElement>(null);
 *   useClipboardPaste(containerRef);
 *   return <div ref={containerRef}>...</div>;
 * }
 * ```
 *
 * @see requirements.md — Requirement 1.6(c), 12.8
 */
export function useClipboardPaste(
  containerRef: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * paste 事件处理器：检测剪贴板中的图片文件并发起传输。
     *
     * 📚 学习要点: ClipboardEvent.clipboardData
     * clipboardData 是一个 DataTransfer 对象（与 drag-and-drop 共用同一接口）。
     * 通过 clipboardData.items 可以遍历剪贴板中的所有条目：
     * - item.kind === 'file': 表示这是一个文件（图片、截图等）
     * - item.type: MIME 类型（如 'image/png'）
     * - item.getAsFile(): 获取 File 对象
     *
     * 为什么遍历 items 而非直接使用 files？
     * - items 提供了 MIME 类型信息，可以精确过滤图片
     * - 某些浏览器中 files 可能为空但 items 有内容
     * - items 是更现代、更可靠的 API
     */
    const handlePaste = (e: ClipboardEvent) => {
      const clipboardData = e.clipboardData;
      if (!clipboardData) return;

      // 遍历剪贴板条目，查找图片文件
      const items = clipboardData.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // 只处理文件类型且 MIME 为图片的条目
        if (item.kind !== 'file') continue;
        if (!item.type.startsWith('image/')) continue;

        const blob = item.getAsFile();
        if (!blob) continue;

        // 📚 学习要点: 为什么创建新的 File 对象？
        // 从剪贴板获取的 File 对象通常没有有意义的文件名（可能是空字符串或 "image.png"）。
        // 我们创建一个新的 File 对象，赋予有意义的名称 `clipboard-{timestamp}.png`：
        // - 包含时间戳，避免多次粘贴时文件名冲突
        // - .png 扩展名，因为剪贴板图片通常是 PNG 格式
        // - 接收方看到文件名就知道这是从剪贴板粘贴的图片
        const timestamp = Date.now();
        const fileName = `clipboard-${timestamp}.png`;
        const file = new File([blob], fileName, { type: blob.type || 'image/png' });

        // 大房间警告检查
        const warning = getLargeRoomWarning();
        if (warning) {
          const confirmed = window.confirm(warning);
          if (!confirmed) return;
        }

        // 发起文件传输
        useFileTransferStore.getState().initiateTransfer(file);

        // 📚 学习要点: 阻止默认粘贴行为
        // 如果不调用 preventDefault()，浏览器可能会将图片作为 base64 数据
        // 插入到 contenteditable 元素中，或者在 input 中插入文件路径文本。
        // 我们已经处理了图片粘贴（作为文件传输），不需要默认行为。
        e.preventDefault();

        // 只处理第一个图片文件（一次粘贴通常只有一个图片）
        break;
      }
    };

    // 📚 学习要点: 事件监听的生命周期管理
    // 在 useEffect 中添加事件监听器，在 cleanup 函数中移除。
    // 这确保了：
    // - 组件挂载时开始监听
    // - 组件卸载时停止监听（防止内存泄漏和幽灵事件处理）
    // - containerRef 变化时重新绑定（通过 deps 数组）
    container.addEventListener('paste', handlePaste);

    return () => {
      container.removeEventListener('paste', handlePaste);
    };
  }, [containerRef]);
}
