import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { MessageInput } from '../components/MessageInput';
import { MessageList } from '../components/MessageList';
import { MemberList } from '../components/MemberList';
import { MemberDrawer } from '../components/MemberDrawer';
import { ShareKey } from '../components/ShareKey';
import { TypingIndicator } from '../components/TypingIndicator';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { ExpiryCountdown } from '../components/ExpiryCountdown';
import { DropZone } from '../file-transfer/components/DropZone';
import { initAudio, requestNotificationPermission } from '../utils/notification';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from '../i18n/components/LanguageSwitcher';

export function ChatRoom() {
  const { t } = useTranslation();
  const roomId = useChatStore((s) => s.roomId);
  const shareCode = useChatStore((s) => s.shareCode);
  const members = useChatStore((s) => s.members);
  const messages = useChatStore((s) => s.messages);
  const myId = useChatStore((s) => s.myId);
  const typingMembers = useChatStore((s) => s.typingMembers);
  const leaveRoom = useChatStore((s) => s.leaveRoom);
  const muted = useChatStore((s) => s.muted);
  const toggleMute = useChatStore((s) => s.toggleMute);
  const hasPassword = useChatStore((s) => s.hasPassword);
  const ephemeral = useChatStore((s) => s.ephemeral);
  const expiresAt = useChatStore((s) => s.expiresAt);

  // Mobile member drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const memberBtnRef = useRef<HTMLButtonElement>(null);

  // Initialize audio + notification permission on first user interaction
  useEffect(() => {
    const handler = () => {
      initAudio();
      requestNotificationPermission();
    };
    document.addEventListener('click', handler, { once: true });
    document.addEventListener('keydown', handler, { once: true });
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('keydown', handler);
    };
  }, []);

  return (
    <div className="flex flex-col h-[var(--app-height)] bg-gray-900 text-white">
      {/* Connection Status Banner */}
      <ConnectionBanner />

      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">{t('chat.header.room')}</span>
          <span className="text-sm text-gray-400 truncate max-w-[120px] sm:max-w-none">{roomId}</span>
          <span className="text-green-400" title={hasPassword ? 'Password protected' : 'End-to-end encrypted'}>{hasPassword ? '🔐' : '🔒'}</span>
          {ephemeral > 0 && <span className="text-amber-400" title={`${t('chat.header.room')} - ${ephemeral}s`}>⏱️</span>}
          <ExpiryCountdown expiresAt={expiresAt} />
        </div>
        <div className="flex items-center gap-2">
          {/* Language switcher (desktop only) */}
          <div className="hidden md:flex">
            <LanguageSwitcher />
          </div>
          {/* Mute button */}
          <button
            onClick={toggleMute}
            aria-label={muted ? t('chat.unmute') : t('chat.mute')}
            title={muted ? t('chat.unmute') : t('chat.mute')}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          >
            {muted ? '🔕' : '🔔'}
          </button>
          {/* Mobile member button */}
          <button
            ref={memberBtnRef}
            onClick={() => setDrawerOpen(true)}
            aria-label={t('member.open')}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white transition-colors md:hidden"
          >
            👥 {members.length}
          </button>
          {/* Leave room button */}
          <button
            onClick={leaveRoom}
            className="min-h-[44px] px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
          >
            {t('chat.header.leave')}
          </button>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat area (messages + typing + input) — 包裹 DropZone 实现拖拽上传覆盖层 */}
        <DropZone>
          {/* Message List */}
          <MessageList messages={messages} myId={myId} members={members} />

          {/* Typing Indicator */}
          <div className="px-4 py-1 shrink-0">
            <TypingIndicator typingMembers={typingMembers} members={members} />
          </div>

          {/* Message Input */}
          <div className="px-4 py-3 bg-gray-800 border-t border-gray-700 shrink-0">
            <MessageInput />
          </div>
        </DropZone>

        {/* Member List Sidebar (desktop only) */}
        <aside className="w-56 bg-gray-800 border-l border-gray-700 overflow-y-auto shrink-0 hidden md:block">
          <MemberList members={members} />
        </aside>
      </div>

      {/* Footer: Share Key */}
      <footer className="flex items-center px-4 py-2 bg-gray-800 border-t border-gray-700 shrink-0">
        <ShareKey shareCode={shareCode} />
      </footer>

      {/* Mobile Member Drawer */}
      <MemberDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        members={members}
        triggerRef={memberBtnRef}
      />
    </div>
  );
}
