/**
 * @file MessageBubble.test.tsx — 消息气泡组件验证状态 UI 测试
 *
 * 测试覆盖：
 * - verified 状态：显示绿色 ✓ 图标（带 aria-label）
 * - failed 状态：显示 ⚠️ 图标 + tooltip 警告文案
 * - unknown 状态：不显示任何验证指示器
 * - no-sig 状态：不显示任何验证指示器
 * - 系统消息：公钥变更警告文案显示
 *
 * @module components/MessageBubble.test
 * @see requirements.md — Requirements 5.2, 5.4
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock i18n — 返回 key 对应的英文翻译（与 en.json 一致）
vi.mock('../i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'verification.verified': 'Signature verified',
        'verification.failed': 'Signature verification failed',
        'verification.failedTooltip': 'Signature verification failed — this message may have been tampered with.',
        'message.reply': 'Reply',
        'message.copy': 'Copy',
        'message.copied': 'Copied',
        'message.addReaction': 'Add reaction',
        'message.jumpTo': 'Jump to message',
      };
      return translations[key] ?? key;
    },
    locale: 'en',
    setLocale: vi.fn(),
  }),
}));

// Mock linkify — 简单返回纯文本段
vi.mock('../utils/linkify', () => ({
  linkify: (text: string) => [{ type: 'text', content: text }],
  truncateUrl: (url: string) => url,
}));

// Mock ReactionPanel — 避免复杂内部依赖
vi.mock('./ReactionPanel', () => ({
  ReactionPanel: () => null,
  getReactionPanelPosition: () => 'above',
}));

// ============================================================================
// 辅助函数
// ============================================================================

/** 创建 MessageBubble 的默认 props */
function defaultProps(overrides: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  return {
    text: 'Hello, world!',
    isOwn: false,
    canCopy: true,
    isDecryptFailed: false,
    stableId: 'user1:1234567890',
    myId: 'my-id',
    ...overrides,
  };
}

// ============================================================================
// 测试
// ============================================================================

describe('MessageBubble — 验证状态指示器', () => {
  describe('verified 状态', () => {
    it('renders a ✓ icon with "Signature verified" aria-label', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'verified' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verified' });
      expect(indicator).toBeInTheDocument();
      expect(indicator.textContent).toBe('✓');
    });

    it('applies green color styling to the verified indicator', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'verified' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verified' });
      expect(indicator.className).toContain('text-green-500');
    });
  });

  describe('failed 状态', () => {
    it('renders a ⚠️ icon with "Signature verification failed" aria-label', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'failed' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verification failed' });
      expect(indicator).toBeInTheDocument();
      expect(indicator.textContent).toContain('⚠️');
    });

    it('shows tooltip on hover with tamper warning text', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'failed' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verification failed' });

      // Tooltip should not be visible initially
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

      // Hover to show tooltip
      fireEvent.mouseEnter(indicator);

      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toBeInTheDocument();
      expect(tooltip.textContent).toBe(
        'Signature verification failed — this message may have been tampered with.'
      );
    });

    it('hides tooltip on mouse leave', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'failed' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verification failed' });

      fireEvent.mouseEnter(indicator);
      expect(screen.getByRole('tooltip')).toBeInTheDocument();

      fireEvent.mouseLeave(indicator);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('shows tooltip on focus (keyboard accessibility)', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'failed' })} />);

      const indicator = screen.getByRole('img', { name: 'Signature verification failed' });

      fireEvent.focus(indicator);
      expect(screen.getByRole('tooltip')).toBeInTheDocument();

      fireEvent.blur(indicator);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  describe('unknown 状態 — 无指示器', () => {
    it('does not render any verification indicator', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'unknown' })} />);

      expect(screen.queryByRole('img', { name: 'Signature verified' })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Signature verification failed' })).not.toBeInTheDocument();
    });
  });

  describe('no-sig 状態 — 无指示器', () => {
    it('does not render any verification indicator', () => {
      render(<MessageBubble {...defaultProps({ verificationStatus: 'no-sig' })} />);

      expect(screen.queryByRole('img', { name: 'Signature verified' })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Signature verification failed' })).not.toBeInTheDocument();
    });
  });

  describe('undefined 状態 — 无指示器', () => {
    it('does not render any verification indicator when status is undefined', () => {
      render(<MessageBubble {...defaultProps()} />);

      expect(screen.queryByRole('img', { name: 'Signature verified' })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'Signature verification failed' })).not.toBeInTheDocument();
    });
  });

  describe('系统消息 — 公钥变更警告', () => {
    it('displays key change warning as system message text', () => {
      // 公钥变更警告作为系统消息显示在聊天中，
      // MessageBubble 渲染该文本内容（由 chatStore 生成）
      const keyChangeText = "⚠️ Alice's signing key has changed";

      render(<MessageBubble {...defaultProps({ text: keyChangeText })} />);

      expect(screen.getByText(keyChangeText)).toBeInTheDocument();
    });
  });
});
