import { useState, useRef } from 'react'
import { linkify, truncateUrl } from '../utils/linkify'
import { ReactionPanel, getReactionPanelPosition } from './ReactionPanel'
import { useTranslation } from '../i18n'
import type { ReplyData, Reaction } from '../stores/chatStore'

interface MessageBubbleProps {
  text: string
  isOwn: boolean
  canCopy: boolean
  isDecryptFailed: boolean
  stableId: string
  reply?: ReplyData
  reactions?: Reaction[]
  myId: string | null
  /** Ed25519 签名验证状态 — 用于显示验证指示器 */
  verificationStatus?: 'verified' | 'failed' | 'unknown' | 'no-sig'
  onReply?: () => void
  onReact?: (emoji: string) => void
  onScrollToMessage?: (stableId: string) => void
}

/**
 * 消息气泡组件 — 封装链接识别、复制、回复引用、反应功能。
 *
 * 桌面端：hover 显示操作按钮（复制 + 回复 + 反应）
 * 移动端：滑动回复 + 双击反应 + 原生长按复制
 */
export function MessageBubble({
  text, isOwn, canCopy, isDecryptFailed,
  reply, reactions, myId, verificationStatus, onReply, onReact, onScrollToMessage,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false)
  const [showReactionPanel, setShowReactionPanel] = useState(false)
  const [reactionPosition, setReactionPosition] = useState<'above' | 'below'>('above')
  const reactBtnRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  // Swipe-to-reply state
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const touchDeltaX = useRef(0)
  const swiping = useRef(false)

  // Double-tap state
  const lastTapTime = useRef(0)

  const handleCopy = async () => {
    if (!canCopy) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const handleReactClick = () => {
    if (reactBtnRef.current) {
      setReactionPosition(getReactionPanelPosition(reactBtnRef.current))
    }
    setShowReactionPanel((v) => !v)
  }

  const handleReact = (emoji: string) => {
    onReact?.(emoji)
    setShowReactionPanel(false)
  }

  // Mobile: swipe-to-reply
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    swiping.current = true
    touchDeltaX.current = 0
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!swiping.current) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = Math.abs(e.touches[0].clientY - touchStartY.current)

    // Vertical scroll > 10px → cancel swipe
    if (dy > 10 && Math.abs(dx) < dy) {
      swiping.current = false
      if (bubbleRef.current) bubbleRef.current.style.transform = ''
      return
    }

    // Only right swipe
    if (dx < 0) { touchDeltaX.current = 0; return }
    touchDeltaX.current = Math.min(dx, 80)
    if (bubbleRef.current) {
      bubbleRef.current.style.transform = `translateX(${touchDeltaX.current}px)`
    }
  }

  const handleTouchEnd = () => {
    if (swiping.current && touchDeltaX.current >= 60 && onReply) {
      onReply()
    }
    swiping.current = false
    touchDeltaX.current = 0
    if (bubbleRef.current) {
      bubbleRef.current.style.transition = 'transform 0.15s ease-out'
      bubbleRef.current.style.transform = ''
      setTimeout(() => {
        if (bubbleRef.current) bubbleRef.current.style.transition = ''
      }, 150)
    }
  }

  // Mobile: double-tap for reactions
  const handleClick = () => {
    const now = Date.now()
    if (now - lastTapTime.current < 300) {
      // Double tap
      if (reactBtnRef.current) {
        setReactionPosition(getReactionPanelPosition(reactBtnRef.current))
      } else if (bubbleRef.current) {
        setReactionPosition(getReactionPanelPosition(bubbleRef.current))
      }
      setShowReactionPanel(true)
      lastTapTime.current = 0
    } else {
      lastTapTime.current = now
    }
  }

  const bgClass = isOwn ? 'bg-indigo-600' : 'bg-gray-700'
  const roundedClass = isOwn ? 'rounded-lg rounded-br-sm' : 'rounded-lg rounded-bl-sm'
  const canInteract = canCopy && !isDecryptFailed

  return (
    <div
      ref={bubbleRef}
      className="relative group [touch-action:manipulation]"
      onTouchStart={canInteract ? handleTouchStart : undefined}
      onTouchMove={canInteract ? handleTouchMove : undefined}
      onTouchEnd={canInteract ? handleTouchEnd : undefined}
      onClick={canInteract ? handleClick : undefined}
    >
      <div className={`${bgClass} text-white px-3 py-2 ${roundedClass}`}>
        {/* Reply quote block */}
        {reply && (
          <div
            onClick={(e) => { e.stopPropagation(); onScrollToMessage?.(reply.stableId) }}
            className="mb-1.5 px-2 py-1 bg-black/20 border-l-2 border-gray-400 rounded text-xs cursor-pointer hover:bg-black/30 transition-colors"
            role="button"
            aria-label={t('message.jumpTo', { name: reply.senderName })}
          >
            <span className="text-gray-300 font-medium">{reply.senderName}</span>
            <p className="text-gray-400 truncate mt-0.5">{reply.preview}</p>
          </div>
        )}

        {/* Message content */}
        {isDecryptFailed ? (
          <span className={`italic ${isOwn ? 'text-red-300' : 'text-red-400'}`}>{text}</span>
        ) : (
          <RichText text={text} />
        )}

        {/* Verification status indicator */}
        <VerificationIndicator status={verificationStatus} />
      </div>

      {/* Desktop hover action buttons */}
      {canInteract && (
        <div className={`absolute -top-3 ${isOwn ? 'right-0' : 'left-0'} hidden md:flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150`}>
          {onReply && (
            <button
              onClick={(e) => { e.stopPropagation(); onReply() }}
              aria-label={t('message.reply')}
              className="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full text-xs hover:bg-gray-500"
            >
              ↩
            </button>
          )}
          <button
            ref={reactBtnRef}
            onClick={(e) => { e.stopPropagation(); handleReactClick() }}
            aria-label={t('message.addReaction')}
            className="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full text-xs hover:bg-gray-500"
          >
            😊
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCopy() }}
            aria-label={t('message.copy')}
            className="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full text-xs hover:bg-gray-500"
          >
            {copied ? '✓' : '📋'}
          </button>
        </div>
      )}

      {/* Copied toast */}
      {copied && (
        <span className="absolute -top-6 right-0 text-xs text-green-400 bg-gray-900 px-1.5 py-0.5 rounded whitespace-nowrap z-10">
          {t('message.copied')}
        </span>
      )}

      {/* Reaction panel */}
      {showReactionPanel && (
        <ReactionPanel
          onReact={handleReact}
          onClose={() => setShowReactionPanel(false)}
          triggerRef={reactBtnRef}
          position={reactionPosition}
        />
      )}

      {/* Reaction summary */}
      {reactions && reactions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {reactions.map((r) => {
            const isMine = myId ? r.userIds.includes(myId) : false
            return (
              <button
                key={r.emoji}
                onClick={(e) => { e.stopPropagation(); onReact?.(r.emoji) }}
                aria-label={`${r.emoji} ${r.userIds.length} ${r.userIds.length === 1 ? 'person' : 'people'}`}
                className={`px-1.5 py-0.5 rounded-full text-xs flex items-center gap-0.5 transition-colors
                  ${isMine ? 'bg-indigo-600/30 border border-indigo-500' : 'bg-gray-700/50 border border-gray-600 hover:border-gray-500'}`}
              >
                <span>{r.emoji}</span>
                <span className="text-gray-400">{r.userIds.length}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 签名验证状态指示器 — 在消息气泡内显示验证结果。
 *
 * 📚 学习要点: TOFU 信任模型的 UI 表达
 * - verified: 签名验证通过，显示微妙的绿色 ✓（不干扰阅读）
 * - failed: 签名验证失败，显示 ⚠️ + tooltip 警告（可能被篡改）
 * - unknown / no-sig: 不显示任何指示器（保持干净的 UI）
 *
 * 设计原则：验证指示器应该是"非侵入式"的 — 正常情况下用户几乎不会注意到，
 * 只有在出现问题（failed）时才引起注意。
 */
function VerificationIndicator({ status }: { status?: 'verified' | 'failed' | 'unknown' | 'no-sig' }) {
  const { t } = useTranslation()
  const [showTooltip, setShowTooltip] = useState(false)

  // unknown 和 no-sig 不显示任何指示器（干净的 UI）
  if (!status || status === 'unknown' || status === 'no-sig') {
    return null
  }

  if (status === 'verified') {
    return (
      <span
        className="inline-block ml-1 text-green-500 opacity-60 text-xs align-middle select-none"
        aria-label={t('verification.verified')}
        role="img"
      >
        ✓
      </span>
    )
  }

  // status === 'failed'
  return (
    <span
      className="relative inline-block ml-1 text-yellow-500 text-xs align-middle select-none cursor-help"
      aria-label={t('verification.failed')}
      role="img"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onFocus={() => setShowTooltip(true)}
      onBlur={() => setShowTooltip(false)}
      tabIndex={0}
    >
      ⚠️
      {showTooltip && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-900 border border-gray-600 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none"
          role="tooltip"
        >
          {t('verification.failedTooltip')}
        </span>
      )}
    </span>
  )
}

/**
 * 富文本渲染 — URL 自动识别为可点击链接。
 */
function RichText({ text }: { text: string }) {
  const segments = linkify(text)

  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className="break-words">{text}</span>
  }

  return (
    <span className="break-words">
      {segments.map((seg, i) =>
        seg.type === 'link' ? (
          <a
            key={i}
            href={seg.content}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 underline hover:text-blue-300"
            title={seg.content}
            onClick={(e) => e.stopPropagation()}
          >
            {truncateUrl(seg.content)}
          </a>
        ) : (
          <span key={i}>{seg.content}</span>
        )
      )}
    </span>
  )
}
