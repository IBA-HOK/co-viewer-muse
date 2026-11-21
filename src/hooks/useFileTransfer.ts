import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LocalMediaIntegrity,
  LocalMediaMeta,
  FileTransferStatus,
} from '../types';
import type {
  TransportFileChannel,
  TransportFileChannelEvent,
} from '../transport/types';
import {
  computeLocalMediaIntegrity,
  probeLocalMedia,
  verifyLocalMediaIntegrity,
  LOCAL_DURATION_TOLERANCE_SEC,
} from '../localFile';
import {
  TRANSFER_BUFFER_HIGH_WATER,
  TRANSFER_CHUNK_SIZE,
  createTransferId,
  decodeChunkFrame,
  encodeChunkFrame,
  getMaxTransferBytes,
  isFileControlMessage,
  type FileControlMessage,
  type FileTransferCancelReason,
} from '../transfer/fileTransfer';

export interface CurrentLocalFile {
  videoId: string;
  file: File;
  meta: LocalMediaMeta;
}

export interface UseFileTransferOptions {
  /** False for MQTT mode: the existing "everyone picks their own copy" flow. */
  enabled: boolean;
  isHost: boolean;
  myId: string | null;
  /** Guest's host peer id (room id in PeerJS). */
  hostPeerId: string | null;
  /** Other participants the host sends to (empty for guests). */
  peers: string[];
  /** Host: the local item currently in the queue. */
  currentLocal: CurrentLocalFile | null;
  /** Guest: videoId of the local item the host is currently playing. */
  activeVideoId: string | null;
  /** Guest: false once the host connection is known to be down. */
  connectionAlive?: boolean;
  /** Guest: does this device already have a verified copy bound? */
  hasLocalFile: (videoId: string) => boolean;
  channel: TransportFileChannel | null;
  onFileReceived: (videoId: string, file: File, meta: LocalMediaMeta) => void;
  /** Test hook; production uses a mobile-aware cap. */
  maxBytes?: number;
}

export interface UseFileTransferResult {
  status: FileTransferStatus;
  /** Ask the host to re-offer the current item (verification failure / error). */
  retry: () => void;
  /** Cancel the current offer/transfer. */
  cancel: () => void;
}

interface OutgoingTransfer {
  peerId: string;
  transferId: number;
  videoId: string;
  file: File;
  meta: LocalMediaMeta;
  integrity: LocalMediaIntegrity;
  offset: number;
  offered: boolean;
  cancelled: boolean;
  sending: boolean;
}

interface IncomingTransfer {
  peerId: string;
  transferId: number;
  videoId: string;
  meta: LocalMediaMeta;
  integrity: LocalMediaIntegrity;
  totalBytes: number;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  cancelled: boolean;
}

interface PartialTransfer {
  videoId: string;
  totalBytes: number;
  chunks: ArrayBuffer[];
  receivedBytes: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function statusFromOffer(
  videoId: string,
  meta: LocalMediaMeta,
  phase: 'offering' | 'transferring',
  receivedBytes = 0
): FileTransferStatus {
  if (phase === 'offering') {
    return { phase: 'offering', videoId, meta };
  }
  return {
    phase: 'transferring',
    videoId,
    meta,
    receivedBytes,
    totalBytes: meta.sizeBytes,
  };
}

/**
 * Host-orchestrated file distribution for the PeerJS transport.
 *
 * The host never sends file bytes over the sync connection: control frames and
 * chunks use a dedicated labelled DataConnection exposed by
 * `transport.fileChannel`. Guests can only receive; the manual local-select
 * flow remains available when this hook is disabled (MQTT / overlarge file).
 */
export function useFileTransfer(
  opts: UseFileTransferOptions
): UseFileTransferResult {
  const {
    enabled,
    isHost,
    myId,
    hostPeerId,
    peers,
    currentLocal,
    activeVideoId,
    connectionAlive = true,
    channel,
    maxBytes,
  } = opts;

  const [status, setStatus] = useState<FileTransferStatus>({ phase: 'idle' });

  const outgoingRef = useRef<Map<string, OutgoingTransfer>>(new Map());
  const incomingRef = useRef<IncomingTransfer | null>(null);
  const partialRef = useRef<PartialTransfer | null>(null);
  const lastPeerRef = useRef<string | null>(null);
  const pendingRequestRef = useRef<string | null>(null);
  const offeringRef = useRef<Set<string>>(new Set());
  const statusRef = useRef<FileTransferStatus>({ phase: 'idle' });
  const progressAtRef = useRef(0);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setStatusSafe = useCallback((next: FileTransferStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const peersKey = peers.join(',');

  const sendControl = useCallback(
    (peerId: string, message: FileControlMessage): boolean => {
      const ch = optsRef.current.channel;
      if (!ch) return false;
      const sent = ch.send(peerId, message);
      if (!sent) {
        ch.open(peerId);
        if (ch.isOpen(peerId)) return ch.send(peerId, message);
      }
      return sent;
    },
    []
  );

  const cancelIncoming = useCallback(
    (reason: FileTransferCancelReason, notifyHost: boolean) => {
      const incoming = incomingRef.current;
      if (!incoming) return;
      incoming.cancelled = true;
      if (notifyHost) {
        sendControl(incoming.peerId, {
          type: 'FILE_CANCEL',
          transferId: incoming.transferId,
          reason,
        });
      }
      incomingRef.current = null;
      partialRef.current = null;
      setStatusSafe({
        phase: 'cancelled',
        videoId: incoming.videoId,
        meta: incoming.meta,
        reason,
      });
    },
    [sendControl, setStatusSafe]
  );

  const cancelOutgoing = useCallback(
    (peerId: string, reason: FileTransferCancelReason) => {
      const entry = outgoingRef.current.get(peerId);
      if (!entry) return;
      entry.cancelled = true;
      outgoingRef.current.delete(peerId);
      if (channel) {
        channel.send(peerId, {
          type: 'FILE_CANCEL',
          transferId: entry.transferId,
          reason,
        });
      }
    },
    [channel]
  );

  const startSending = useCallback(
    async (entry: OutgoingTransfer) => {
      const ch = optsRef.current.channel;
      if (!ch || entry.sending) return;
      entry.sending = true;
      let failures = 0;
      try {
        while (!entry.cancelled && entry.offset < entry.file.size) {
          if (!ch.isOpen(entry.peerId)) {
            entry.cancelled = true;
            break;
          }
          const end = Math.min(entry.offset + TRANSFER_CHUNK_SIZE, entry.file.size);
          const payload = await entry.file.slice(entry.offset, end).arrayBuffer();
          if (entry.cancelled) break;
          const frame = encodeChunkFrame(
            entry.transferId,
            entry.offset,
            payload
          );
          if (!ch.send(entry.peerId, frame)) {
            failures += 1;
            if (failures > 80) {
              entry.cancelled = true;
              break;
            }
            ch.open(entry.peerId);
            await sleep(25);
            continue;
          }
          failures = 0;
          entry.offset = end;
          // Never queue the whole file in the DataChannel: wait until the
          // browser's buffer is back under the low-water mark.
          while (
            !entry.cancelled &&
            ch.bufferedAmount(entry.peerId) >= TRANSFER_BUFFER_HIGH_WATER
          ) {
            await sleep(20);
          }
        }
        if (!entry.cancelled && entry.offset >= entry.file.size) {
          ch.send(entry.peerId, {
            type: 'FILE_END',
            transferId: entry.transferId,
          });
        }
      } finally {
        entry.sending = false;
      }
    },
    []
  );

  const offerToPeer = useCallback(
    async (peerId: string, local: CurrentLocalFile, force = false) => {
      const currentOpts = optsRef.current;
      if (!currentOpts.enabled || !currentOpts.isHost || !currentOpts.channel) {
        return;
      }
      const limit = currentOpts.maxBytes ?? getMaxTransferBytes();
      if (
        !local.meta.sizeBytes ||
        local.meta.sizeBytes > limit ||
        local.file.size > limit
      ) {
        return;
      }
      const existing = outgoingRef.current.get(peerId);
      if (existing && !force) {
        if (existing.videoId === local.videoId && !existing.cancelled) return;
        cancelOutgoing(peerId, 'queue-changed');
      }
      const guardKey = `${peerId}:${local.videoId}`;
      if (offeringRef.current.has(guardKey)) return;
      offeringRef.current.add(guardKey);
      try {
        let integrity = local.meta.integrity;
        if (!integrity) {
          try {
            integrity = await computeLocalMediaIntegrity(local.file);
          } catch {
            // Verification is mandatory; never offer an unverifiable file.
            console.warn('[fileTransfer] cannot fingerprint the file; not offering');
            return;
          }
        }
        const meta: LocalMediaMeta = { ...local.meta, integrity };
        const entry: OutgoingTransfer = {
          peerId,
          transferId: createTransferId(),
          videoId: local.videoId,
          file: local.file,
          meta,
          integrity,
          offset: 0,
          offered: false,
          cancelled: false,
          sending: false,
        };
        outgoingRef.current.set(peerId, entry);
        const message: FileControlMessage = {
          type: 'FILE_OFFER',
          transferId: entry.transferId,
          videoId: local.videoId,
          meta,
          totalBytes: local.file.size,
          integrity,
        };
        const ch = currentOpts.channel;
        entry.offered = ch.send(peerId, message);
        if (!entry.offered) ch.open(peerId);
      } finally {
        offeringRef.current.delete(guardKey);
      }
    },
    [cancelOutgoing]
  );

  const handleIncomingData = useCallback(
    (peerId: string, data: unknown) => {
      const currentOpts = optsRef.current;

      if (isFileControlMessage(data)) {
        if (currentOpts.isHost) {
          switch (data.type) {
            case 'FILE_ACCEPT': {
              const entry = outgoingRef.current.get(peerId);
              if (!entry || entry.transferId !== data.transferId) break;
              if (data.offset > entry.file.size) break;
              entry.offset = data.offset;
              void startSending(entry);
              break;
            }
            case 'FILE_CANCEL': {
              const entry = outgoingRef.current.get(peerId);
              if (!entry || entry.transferId !== data.transferId) break;
              entry.cancelled = true;
              outgoingRef.current.delete(peerId);
              break;
            }
            case 'FILE_REQUEST': {
              const local = currentOpts.currentLocal;
              if (!local || local.videoId !== data.videoId) break;
              void offerToPeer(peerId, local, true);
              break;
            }
            default:
              break;
          }
          return;
        }

        // Guest side.
        switch (data.type) {
          case 'FILE_OFFER': {
            if (!currentOpts.enabled) return;
            lastPeerRef.current = peerId;
            if (
              data.meta.sizeBytes !== data.totalBytes ||
              data.totalBytes <= 0
            ) {
              sendControl(peerId, {
                type: 'FILE_CANCEL',
                transferId: data.transferId,
                reason: 'verification-failed',
              });
              return;
            }
            const limit = currentOpts.maxBytes ?? getMaxTransferBytes();
            if (data.totalBytes > limit) {
              sendControl(peerId, {
                type: 'FILE_CANCEL',
                transferId: data.transferId,
                reason: 'too-large',
              });
              setStatusSafe({
                phase: 'error',
                videoId: data.videoId,
                meta: data.meta,
                message:
                  'ファイルが大きすぎるため自動受信できません。各自の端末でファイルを選択してください。',
                retryable: false,
                fallbackToManual: true,
              });
              return;
            }
            if (currentOpts.hasLocalFile(data.videoId)) {
              sendControl(peerId, {
                type: 'FILE_CANCEL',
                transferId: data.transferId,
                reason: 'already-have',
              });
              setStatusSafe({ phase: 'idle' });
              return;
            }
            const partial = partialRef.current;
            const canResume =
              !!partial &&
              partial.videoId === data.videoId &&
              partial.totalBytes === data.totalBytes;
            const chunks = canResume ? partial!.chunks : [];
            const receivedBytes = canResume ? partial!.receivedBytes : 0;
            const incoming: IncomingTransfer = {
              peerId,
              transferId: data.transferId,
              videoId: data.videoId,
              meta: data.meta,
              integrity: data.integrity,
              totalBytes: data.totalBytes,
              chunks,
              receivedBytes,
              cancelled: false,
            };
            incomingRef.current = incoming;
            partialRef.current = null;
            progressAtRef.current = 0;
            setStatusSafe(
              canResume && receivedBytes > 0
                ? {
                    phase: 'transferring',
                    videoId: data.videoId,
                    meta: data.meta,
                    receivedBytes,
                    totalBytes: data.totalBytes,
                  }
                : { phase: 'offering', videoId: data.videoId, meta: data.meta }
            );
            sendControl(peerId, {
              type: 'FILE_ACCEPT',
              transferId: data.transferId,
              offset: receivedBytes,
            });
            if (canResume) {
              setStatusSafe(
                statusFromOffer(
                  data.videoId,
                  data.meta,
                  'transferring',
                  receivedBytes
                )
              );
            }
            break;
          }
          case 'FILE_CANCEL': {
            const incoming = incomingRef.current;
            if (!incoming || incoming.transferId !== data.transferId) break;
            incoming.cancelled = true;
            incomingRef.current = null;
            partialRef.current = null;
            setStatusSafe({
              phase: 'cancelled',
              videoId: incoming.videoId,
              meta: incoming.meta,
              reason: data.reason,
            });
            break;
          }
          case 'FILE_END': {
            const incoming = incomingRef.current;
            if (!incoming || incoming.transferId !== data.transferId) break;
            const done = incoming;
            incomingRef.current = null;
            setStatusSafe({
              phase: 'verifying',
              videoId: done.videoId,
              meta: done.meta,
              receivedBytes: done.receivedBytes,
              totalBytes: done.totalBytes,
            });
            void (async () => {
              if (
                done.receivedBytes !== done.totalBytes ||
                done.chunks.length === 0
              ) {
                sendControl(peerId, {
                  type: 'FILE_CANCEL',
                  transferId: done.transferId,
                  reason: 'verification-failed',
                });
                setStatusSafe({
                  phase: 'error',
                  videoId: done.videoId,
                  meta: done.meta,
                  message: '受信したファイルのサイズが一致しません。',
                  retryable: true,
                  fallbackToManual: false,
                });
                return;
              }
              const blob = new Blob(done.chunks, {
                type: done.meta.mimeType || 'application/octet-stream',
              });
              const file = new File([blob], done.meta.fileName, {
                type: done.meta.mimeType,
                lastModified: Date.now(),
              });
              let integrityOk = false;
              try {
                integrityOk = await verifyLocalMediaIntegrity(
                  file,
                  done.integrity
                );
              } catch {
                integrityOk = false;
              }
              let durationOk = true;
              if (integrityOk && done.meta.durationSec > 0) {
                try {
                  const probed = await probeLocalMedia(file, { timeoutMs: 2000 });
                  if (probed.durationSec > 0) {
                    durationOk =
                      Math.abs(probed.durationSec - done.meta.durationSec) <=
                      LOCAL_DURATION_TOLERANCE_SEC;
                  }
                } catch {
                  // A browser that cannot re-probe the blob still has the
                  // size + sampled-hash match, so keep the transfer.
                }
              }
              if (!integrityOk || !durationOk) {
                sendControl(peerId, {
                  type: 'FILE_CANCEL',
                  transferId: done.transferId,
                  reason: 'verification-failed',
                });
                setStatusSafe({
                  phase: 'error',
                  videoId: done.videoId,
                  meta: done.meta,
                  message: '受信したファイルをホストのファイルと照合できませんでした。',
                  retryable: true,
                  fallbackToManual: false,
                });
                return;
              }
              currentOpts.onFileReceived(done.videoId, file, {
                ...done.meta,
                integrity: done.integrity,
              });
              setStatusSafe({
                phase: 'ready',
                videoId: done.videoId,
                meta: { ...done.meta, integrity: done.integrity },
                receivedBytes: done.receivedBytes,
                totalBytes: done.totalBytes,
              });
            })();
            break;
          }
          default:
            break;
        }
        return;
      }

      // Binary frames are chunks. Only a guest assembling an accepted offer
      // may append them.
      if (currentOpts.isHost) return;
      const incoming = incomingRef.current;
      if (!incoming) return;
      const frame = decodeChunkFrame(data);
      if (!frame || frame.transferId !== incoming.transferId) return;
      if (frame.offset !== incoming.receivedBytes) {
        // Reliable+ordered makes a gap a protocol error; a duplicate (offset
        // already appended) is harmless.
        if (frame.offset < incoming.receivedBytes) return;
        incoming.cancelled = true;
        incomingRef.current = null;
        setStatusSafe({
          phase: 'error',
          videoId: incoming.videoId,
          meta: incoming.meta,
          message: '受信データの順序が不正です。',
          retryable: true,
          fallbackToManual: false,
        });
        return;
      }
      // Copy: PeerJS may reuse its receive buffer.
      incoming.chunks.push(frame.payload);
      incoming.receivedBytes += frame.payload.byteLength;
      const now = Date.now();
      if (
        now - progressAtRef.current > 200 ||
        incoming.receivedBytes >= incoming.totalBytes
      ) {
        progressAtRef.current = now;
        setStatusSafe({
          phase: 'transferring',
          videoId: incoming.videoId,
          meta: incoming.meta,
          receivedBytes: incoming.receivedBytes,
          totalBytes: incoming.totalBytes,
        });
      }
    },
    [offerToPeer, sendControl, setStatusSafe, startSending]
  );

  // Subscribe to the dedicated channel once; the handler lives in a ref so the
  // subscription does not churn on renders.
  const handlerRef = useRef(handleIncomingData);
  handlerRef.current = handleIncomingData;

  useEffect(() => {
    if (!enabled || !channel) return;
    return channel.subscribe((event: TransportFileChannelEvent) => {
      if (event.kind === 'data') {
        handlerRef.current(event.peerId, event.data);
        return;
      }
      if (event.kind === 'open') {
        if (optsRef.current.isHost) {
          const entry = outgoingRef.current.get(event.peerId);
          const ch = optsRef.current.channel;
          if (entry && !entry.offered && ch) {
            entry.offered = ch.send(event.peerId, {
              type: 'FILE_OFFER',
              transferId: entry.transferId,
              videoId: entry.videoId,
              meta: entry.meta,
              totalBytes: entry.file.size,
              integrity: entry.integrity,
            } satisfies FileControlMessage);
          }
        } else {
          const request = pendingRequestRef.current;
          if (request) {
            pendingRequestRef.current = null;
            sendControl(event.peerId, {
              type: 'FILE_REQUEST',
              videoId: request,
            });
          }
        }
        return;
      }
      if (event.kind === 'close') {
        const incoming = incomingRef.current;
        if (incoming && incoming.peerId === event.peerId) {
          // Keep the chunks so a re-offer can resume from this offset.
          partialRef.current = {
            videoId: incoming.videoId,
            totalBytes: incoming.totalBytes,
            chunks: incoming.chunks,
            receivedBytes: incoming.receivedBytes,
          };
          incomingRef.current = null;
          setStatusSafe({
            phase: 'cancelled',
            videoId: incoming.videoId,
            meta: incoming.meta,
            reason: 'host-disconnected',
          });
        }
        const outgoing = outgoingRef.current.get(event.peerId);
        if (outgoing) {
          outgoing.cancelled = true;
          outgoingRef.current.delete(event.peerId);
        }
      }
    });
  }, [channel, enabled, sendControl, setStatusSafe]);

  // Host: start/stop offers when the current local item or participant set
  // changes. A queue change cancels any in-flight distribution immediately.
  useEffect(() => {
    if (!enabled || !isHost || !channel) return;
    const currentVideoId = currentLocal?.videoId ?? null;
    for (const [peerId, entry] of [...outgoingRef.current.entries()]) {
      if (!peers.includes(peerId)) {
        cancelOutgoing(peerId, 'host-disconnected');
      } else if (entry.videoId !== currentVideoId) {
        cancelOutgoing(peerId, 'queue-changed');
      }
    }
    if (!currentLocal) return;
    const limit = maxBytes ?? getMaxTransferBytes();
    if (
      !currentLocal.meta.sizeBytes ||
      currentLocal.meta.sizeBytes > limit ||
      currentLocal.file.size > limit
    ) {
      return;
    }
    for (const peerId of peers) {
      if (peerId === myId) continue;
      void offerToPeer(peerId, currentLocal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    isHost,
    channel,
    currentLocal?.videoId,
    currentLocal?.file,
    currentLocal?.meta,
    peersKey,
    myId,
    maxBytes,
    cancelOutgoing,
    offerToPeer,
  ]);

  // Guest: a queue change cancels the current transfer. A move to a different
  // local item makes this transfer useless; an empty pointer cancels too.
  useEffect(() => {
    if (isHost) return;
    const incoming = incomingRef.current;
    if (!incoming) return;
    if (activeVideoId !== incoming.videoId) {
      cancelIncoming('queue-changed', true);
    }
  }, [activeVideoId, cancelIncoming, isHost]);

  // Guest: the host leaving cancels the receive even if the DataChannel close
  // event is delayed (or never arrives).
  const wasAliveRef = useRef(connectionAlive);
  useEffect(() => {
    const wasAlive = wasAliveRef.current;
    wasAliveRef.current = connectionAlive;
    if (isHost) return;
    if (wasAlive && !connectionAlive) {
      cancelIncoming('host-disconnected', false);
    }
  }, [connectionAlive, cancelIncoming, isHost]);

  // Unmount / disable: abandon everything in flight.
  useEffect(() => {
    if (enabled) return;
    cancelIncoming('host-disconnected', true);
    for (const peerId of [...outgoingRef.current.keys()]) {
      cancelOutgoing(peerId, 'host-disconnected');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(
    () => () => {
      for (const peerId of [...outgoingRef.current.keys()]) {
        cancelOutgoing(peerId, 'host-disconnected');
      }
      incomingRef.current = null;
      partialRef.current = null;
    },
    // Only on unmount; cancelOutgoing is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const retry = useCallback(() => {
    if (isHost) return;
    const current = statusRef.current;
    if (current.phase === 'idle') return;
    const videoId = current.videoId;
    const peerId = lastPeerRef.current ?? hostPeerId;
    if (!peerId || !channel) return;
    setStatusSafe({
      phase: 'offering',
      videoId,
      meta: current.meta,
    });
    if (!sendControl(peerId, { type: 'FILE_REQUEST', videoId })) {
      pendingRequestRef.current = videoId;
      channel.open(peerId);
    }
  }, [channel, hostPeerId, isHost, sendControl, setStatusSafe]);

  const cancel = useCallback(() => {
    if (isHost) return;
    cancelIncoming('user', true);
  }, [cancelIncoming, isHost]);

  return { status, retry, cancel };
}
