import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  peerId: string;
  name: string;
  text: string;
  timestamp: number;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  myId: string | null;
  onSend: (text: string) => void;
  fillViewport?: boolean;
}

const AUTO_SCROLL_THRESHOLD = 60;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export default function ChatPanel({ messages, myId, onSend, fillViewport }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const maxScrollTop = el.scrollHeight - el.clientHeight;
    const nearBottom = maxScrollTop - el.scrollTop < AUTO_SCROLL_THRESHOLD;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={fillViewport ? 'flex min-h-0 w-full flex-1 flex-col space-y-2 p-3 pb-4' : 'flex min-h-[68vh] w-full flex-col space-y-2'}>
      <div
        ref={listRef}
        className={fillViewport ? 'min-h-0 flex-1 space-y-2 overflow-y-auto pr-1' : 'min-h-[30vh] max-h-[62vh] flex-1 space-y-2 overflow-y-auto pr-1'}
      >
        {messages.length === 0 && (
          <p className="nothing-mono pt-6 text-center text-[11px] tracking-widest text-[var(--nothing-text-faint)]">
            NO MESSAGES YET
          </p>
        )}
        {messages.map((m) => {
          const isOwn = m.peerId === myId;
          return (
            <div
              key={m.id}
              className={`chat-msg-enter flex ${isOwn ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`flex max-w-[75%] flex-col ${isOwn ? 'items-end' : 'items-start'}`}
              >
                <div className="nothing-mono mb-0.5 flex items-center gap-1.5 text-[9px] tracking-widest text-[var(--nothing-text-dim)]">
                  <span className="text-[var(--nothing-text-muted)]">{m.name}</span>
                  <span>{formatTime(m.timestamp)}</span>
                </div>
                <div
                  className="px-2.5 py-1.5 text-sm border"
                  style={{
                    borderRadius: 2,
                    backgroundColor: isOwn
                      ? 'var(--nothing-red)'
                      : 'var(--nothing-surface-raised)',
                    color: isOwn ? '#fff' : 'var(--nothing-text)',
                    borderColor: isOwn
                      ? 'transparent'
                      : 'var(--nothing-border)',
                    display: 'inline-block',
                  }}
                >
                  {m.text}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sticky bottom-0 flex items-center gap-2 bg-[var(--nothing-bg)] pb-1 pt-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={500}
          placeholder="MESSAGE..."
          className="nothing-mono min-w-0 flex-1 border border-[var(--nothing-border)] bg-black px-2.5 py-1.5 text-xs tracking-widest text-[var(--nothing-text)] placeholder:text-[var(--nothing-text-faint)]"
          style={{ borderRadius: 2 }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim()}
          className="nothing-mono shrink-0 border border-[var(--nothing-red)] bg-[var(--nothing-red)] px-3 py-1.5 text-[11px] font-bold tracking-widest text-white hover:bg-[var(--nothing-red-hover)] disabled:cursor-not-allowed disabled:opacity-30"
          style={{ borderRadius: 2 }}
        >
          SEND
        </button>
      </div>
    </div>
  );
}
