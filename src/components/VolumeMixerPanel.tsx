import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Participant, PlayerController } from '../types';
import type { UseVoiceChatResult } from '../hooks/useVoiceChat';

interface VolumeMixerPanelProps {
  controllerRef: MutableRefObject<PlayerController | null>;
  voiceChat: UseVoiceChatResult;
  participants: Participant[];
  currentPlatform: 'youtube' | 'niconico' | null;
  currentId?: string | null;
}

interface MixerState {
  yt: number;
  nico: number;
  vcMaster: number;
  vcPeers: Record<string, number>;
}

const MIXER_KEY = 'co-viewer:mixer';
const DEFAULT_MIXER: MixerState = { yt: 100, nico: 100, vcMaster: 100, vcPeers: {} };

function loadMixer(): MixerState {
  try {
    const raw = localStorage.getItem(MIXER_KEY);
    if (raw) {
      const m = JSON.parse(raw) as Partial<MixerState>;
      return {
        yt: typeof m.yt === 'number' ? m.yt : 100,
        nico: typeof m.nico === 'number' ? m.nico : 100,
        vcMaster: typeof m.vcMaster === 'number' ? m.vcMaster : 100,
        vcPeers: m.vcPeers ?? {},
      };
    }
  } catch {}
  return { ...DEFAULT_MIXER };
}

export default function VolumeMixerPanel({ controllerRef, voiceChat, participants, currentPlatform, currentId }: VolumeMixerPanelProps) {
  const [mixer, setMixer] = useState<MixerState>(() => loadMixer());
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem('co-viewer:mixer-expanded') === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(MIXER_KEY, JSON.stringify(mixer)); } catch {}
  }, [mixer]);

  useEffect(() => {
    try { localStorage.setItem('co-viewer:mixer-expanded', expanded ? '1' : '0'); } catch {}
  }, [expanded]);

  useEffect(() => {
    const c = controllerRef.current;
    if (!c?.setVolume) return;
    if (currentPlatform === 'youtube') c.setVolume(mixer.yt);
    else if (currentPlatform === 'niconico') c.setVolume(mixer.nico);
  }, [currentPlatform, currentId, mixer.yt, mixer.nico, controllerRef]);

  useEffect(() => {
    if (!currentId) return;
    const t = window.setTimeout(() => {
      const c = controllerRef.current;
      if (!c?.setVolume) return;
      if (currentPlatform === 'youtube') c.setVolume(mixer.yt);
      else if (currentPlatform === 'niconico') c.setVolume(mixer.nico);
    }, 600);
    return () => window.clearTimeout(t);
  }, [currentId, currentPlatform, mixer.yt, mixer.nico, controllerRef]);

  useEffect(() => {
    voiceChat.setMasterVolume(mixer.vcMaster);
    Object.entries(mixer.vcPeers).forEach(([peerId, vol]) => {
      voiceChat.setPeerVolume(peerId, vol);
    });
  }, [voiceChat.setMasterVolume, voiceChat.setPeerVolume, mixer.vcMaster, mixer.vcPeers]);

  const update = (patch: Partial<MixerState>) => setMixer((prev) => ({ ...prev, ...patch }));

  return (
    <div className="nothing-panel p-3 space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <h3 className="nothing-title text-sm tracking-[0.12em] text-[var(--nothing-text)]">MIXER</h3>
          <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">
            YT {mixer.yt} · NICO {mixer.nico} · VC {mixer.vcMaster}
          </span>
        </div>
        <span className="nothing-mono shrink-0 border border-[var(--nothing-border)] bg-black px-2 py-0.5 text-[11px] tracking-widest text-[var(--nothing-text-dim)]">
          {expanded ? '—' : '+'}
        </span>
      </button>
      <div className="nothing-glyph opacity-30" aria-hidden />
      {!expanded && (
        <p className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-faint)]">TAP TO ADJUST · YT / NICO / VC</p>
      )}

      {expanded && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className={`nothing-mono text-[10px] tracking-widest ${currentPlatform === 'youtube' ? 'text-[var(--nothing-red)]' : 'text-[var(--nothing-text-dim)]'}`}>YOUTUBE {currentPlatform === 'youtube' ? '●' : ''}</span>
                <span className="nothing-mono text-[10px] text-[var(--nothing-text-dim)]">{mixer.yt}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={mixer.yt}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  update({ yt: v });
                  if (currentPlatform === 'youtube') controllerRef.current?.setVolume?.(v);
                }}
                className="w-full accent-[var(--nothing-red)]"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className={`nothing-mono text-[10px] tracking-widest ${currentPlatform === 'niconico' ? 'text-[var(--nothing-red)]' : 'text-[var(--nothing-text-dim)]'}`}>NICONICO {currentPlatform === 'niconico' ? '●' : ''}</span>
                <span className="nothing-mono text-[10px] text-[var(--nothing-text-dim)]">{mixer.nico}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={mixer.nico}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  update({ nico: v });
                  if (currentPlatform === 'niconico') controllerRef.current?.setVolume?.(v);
                }}
                className="w-full accent-[var(--nothing-red)]"
              />
            </div>
          </div>

          <div className="space-y-2 border-t border-[var(--nothing-border)] pt-3">
            <div className="flex items-center justify-between">
              <span className="nothing-mono text-[10px] tracking-widest text-[var(--nothing-text-dim)]">VC MASTER</span>
              <span className="nothing-mono text-[10px] text-[var(--nothing-text-dim)]">{mixer.vcMaster}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={mixer.vcMaster}
              onChange={(e) => {
                const v = Number(e.target.value);
                update({ vcMaster: v });
                voiceChat.setMasterVolume(v);
              }}
              className="w-full accent-[var(--nothing-red)]"
            />
            {participants.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {participants.map((p) => {
                  const vol = mixer.vcPeers[p.peerId] ?? 100;
                  const hasStream = !!voiceChat.remoteStreams[p.peerId];
                  return (
                    <div key={p.peerId} className="flex items-center gap-1.5 border border-[var(--nothing-border)] bg-black px-2 py-1">
                      <span className="nothing-mono min-w-0 flex-1 truncate text-[10px] tracking-wide text-[var(--nothing-text)]">
                        {p.name} {hasStream ? '' : '· idle'}
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={vol}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          const next = { ...mixer.vcPeers, [p.peerId]: v };
                          update({ vcPeers: next });
                          voiceChat.setPeerVolume(p.peerId, v);
                        }}
                        className="w-20 shrink-0 accent-[var(--nothing-red)]"
                      />
                      <span className="nothing-mono w-6 text-right text-[10px] text-[var(--nothing-text-dim)]">{vol}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
