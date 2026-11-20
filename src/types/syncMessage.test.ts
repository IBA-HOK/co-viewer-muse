import { describe, expect, it } from 'vitest';
import {
  isValidSyncMessage,
  MAX_CHAT_NAME_LENGTH,
  MAX_CHAT_TEXT_LENGTH,
  type Participant,
  type QueueItem,
  type SyncMessage,
} from './index';

const QUEUE: QueueItem[] = [
  {
    id: 'youtube:abc123def45',
    platform: 'youtube',
    videoId: 'abc123def45',
    addedBy: 'Host',
  },
];

const PARTICIPANTS: Participant[] = [
  { peerId: 'host-1', name: 'Host', isHost: true, role: 'Host' },
  { peerId: 'guest-1', name: 'Guest', isHost: false, role: 'Viewer' },
];

const VALID_MESSAGES: SyncMessage[] = [
  { type: 'PLAY', currentTime: 1, senderId: 'peer-1' },
  { type: 'PAUSE', currentTime: 2, senderId: 'peer-1' },
  { type: 'SEEK', currentTime: 3, senderId: 'peer-1' },
  {
    type: 'SYNC_PING',
    currentTime: 4,
    isPlaying: true,
    senderId: 'peer-1',
  },
  {
    type: 'SYNC_PING',
    currentTime: 5,
    isPlaying: false,
    sentAt: 1_700_000_000_000,
    senderId: 'peer-1',
  },
  {
    type: 'ROLE_UPDATE',
    targetPeerId: 'guest-1',
    role: 'Controller',
    senderId: 'host-1',
  },
  { type: 'PARTICIPANTS', participants: PARTICIPANTS, senderId: 'host-1' },
  { type: 'REQUEST_STATE', senderId: 'guest-1' },
  {
    type: 'QUEUE_UPDATE',
    queue: QUEUE,
    currentId: QUEUE[0].id,
    currentTime: 6,
    senderId: 'host-1',
  },
  {
    type: 'QUEUE_UPDATE',
    queue: [],
    currentId: null,
    currentTime: 0,
    restart: true,
    senderId: 'host-1',
  },
  {
    type: 'STATE_SNAPSHOT',
    platform: 'youtube',
    videoId: 'abc123def45',
    currentTime: 7,
    isPlaying: true,
    queue: QUEUE,
    currentId: QUEUE[0].id,
    senderId: 'host-1',
  },
  { type: 'NAME_UPDATE', peerId: 'peer-1', name: 'Alice', senderId: 'peer-1' },
  { type: 'VC_STATE', active: true, senderId: 'host-1' },
  { type: 'VC_PEER', peerId: 'guest-1', inVc: true, senderId: 'guest-1' },
  {
    type: 'DRIVE_MODE',
    enabled: true,
    audioOnly: false,
    senderId: 'host-1',
  },
  {
    type: 'CHAT_MESSAGE',
    peerId: 'guest-1',
    name: 'Guest',
    text: 'hello',
    timestamp: 8,
    senderId: 'guest-1',
  },
];

describe('isValidSyncMessage', () => {
  it.each(VALID_MESSAGES)('accepts a valid $type message', (message) => {
    expect(isValidSyncMessage(message)).toBe(true);
  });

  it('accepts chat text at the length limit and names at the name limit', () => {
    expect(
      isValidSyncMessage({
        type: 'CHAT_MESSAGE',
        peerId: 'guest-1',
        name: 'n'.repeat(MAX_CHAT_NAME_LENGTH),
        text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH),
        timestamp: 9,
        senderId: 'guest-1',
      })
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'PLAY'],
    ['an object without a type', { senderId: 'peer-1' }],
    ['an object with an unknown type', { type: 'NOT_A_SYNC_MESSAGE' }],
  ])('rejects %s', (_label, value) => {
    expect(isValidSyncMessage(value)).toBe(false);
  });

  it.each([
    ['PLAY missing senderId', { type: 'PLAY', currentTime: 1 }],
    ['PLAY with a non-finite currentTime', { type: 'PLAY', currentTime: Infinity, senderId: 'peer-1' }],
    ['PAUSE with a string currentTime', { type: 'PAUSE', currentTime: '1', senderId: 'peer-1' }],
    ['SEEK missing currentTime', { type: 'SEEK', senderId: 'peer-1' }],
    [
      'SYNC_PING missing isPlaying',
      { type: 'SYNC_PING', currentTime: 1, senderId: 'peer-1' },
    ],
    [
      'SYNC_PING with a string sentAt',
      { type: 'SYNC_PING', currentTime: 1, isPlaying: true, sentAt: 'now', senderId: 'peer-1' },
    ],
    [
      'PARTICIPANTS with a non-array payload',
      { type: 'PARTICIPANTS', participants: {}, senderId: 'host-1' },
    ],
    [
      'PARTICIPANTS with an invalid participant role',
      {
        type: 'PARTICIPANTS',
        participants: [{ peerId: 'guest-1', name: 'Guest', isHost: false, role: 'Owner' }],
        senderId: 'host-1',
      },
    ],
    [
      'PARTICIPANTS with a non-boolean isHost',
      {
        type: 'PARTICIPANTS',
        participants: [{ peerId: 'guest-1', name: 'Guest', isHost: 'no', role: 'Viewer' }],
        senderId: 'host-1',
      },
    ],
    [
      'QUEUE_UPDATE missing queue',
      { type: 'QUEUE_UPDATE', currentId: null, currentTime: 0, senderId: 'host-1' },
    ],
    [
      'QUEUE_UPDATE with an invalid queue item platform',
      {
        type: 'QUEUE_UPDATE',
        queue: [{ id: 'vimeo:1', platform: 'vimeo', videoId: '1', addedBy: 'Host' }],
        currentId: 'vimeo:1',
        currentTime: 0,
        senderId: 'host-1',
      },
    ],
    [
      'QUEUE_UPDATE with an invalid currentId',
      { type: 'QUEUE_UPDATE', queue: QUEUE, currentId: 1, currentTime: 0, senderId: 'host-1' },
    ],
    [
      'QUEUE_UPDATE with an invalid restart',
      {
        type: 'QUEUE_UPDATE',
        queue: QUEUE,
        currentId: QUEUE[0].id,
        currentTime: 0,
        restart: 'yes',
        senderId: 'host-1',
      },
    ],
    [
      'STATE_SNAPSHOT with a non-boolean isPlaying',
      {
        type: 'STATE_SNAPSHOT',
        platform: 'youtube',
        videoId: 'abc123def45',
        currentTime: 1,
        isPlaying: 'yes',
        queue: QUEUE,
        currentId: QUEUE[0].id,
        senderId: 'host-1',
      },
    ],
    [
      'STATE_SNAPSHOT with an invalid platform',
      {
        type: 'STATE_SNAPSHOT',
        platform: 'vimeo',
        videoId: 'abc123def45',
        currentTime: 1,
        isPlaying: true,
        queue: QUEUE,
        currentId: QUEUE[0].id,
        senderId: 'host-1',
      },
    ],
    [
      'NAME_UPDATE with a non-string name',
      { type: 'NAME_UPDATE', peerId: 'peer-1', name: 1, senderId: 'peer-1' },
    ],
    [
      'VC_PEER with a non-boolean inVc',
      { type: 'VC_PEER', peerId: 'guest-1', inVc: 'yes', senderId: 'guest-1' },
    ],
    [
      'DRIVE_MODE missing audioOnly',
      { type: 'DRIVE_MODE', enabled: true, senderId: 'host-1' },
    ],
    [
      'VC_STATE with a non-boolean active',
      { type: 'VC_STATE', active: 'yes', senderId: 'host-1' },
    ],
    [
      'CHAT_MESSAGE with a non-string text',
      {
        type: 'CHAT_MESSAGE',
        peerId: 'guest-1',
        name: 'Guest',
        text: 1,
        timestamp: 1,
        senderId: 'guest-1',
      },
    ],
    [
      'CHAT_MESSAGE with a non-finite timestamp',
      {
        type: 'CHAT_MESSAGE',
        peerId: 'guest-1',
        name: 'Guest',
        text: 'hello',
        timestamp: Infinity,
        senderId: 'guest-1',
      },
    ],
    [
      'CHAT_MESSAGE with text over the limit',
      {
        type: 'CHAT_MESSAGE',
        peerId: 'guest-1',
        name: 'Guest',
        text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1),
        timestamp: 1,
        senderId: 'guest-1',
      },
    ],
    [
      'CHAT_MESSAGE with a name over the limit',
      {
        type: 'CHAT_MESSAGE',
        peerId: 'guest-1',
        name: 'n'.repeat(MAX_CHAT_NAME_LENGTH + 1),
        text: 'hello',
        timestamp: 1,
        senderId: 'guest-1',
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(isValidSyncMessage(value)).toBe(false);
  });
});

describe('isValidSyncMessage · local file metadata', () => {
  const LOCAL_META = {
    fileName: 'holiday.mp4',
    sizeBytes: 123456,
    durationSec: 90,
    mimeType: 'video/mp4',
  };
  const LOCAL_ITEM: QueueItem = {
    id: 'local:local-abcdefgh',
    platform: 'local',
    videoId: 'local-abcdefgh',
    addedBy: 'Host',
    local: LOCAL_META,
  };
  const LOCAL_QUEUE = [LOCAL_ITEM];

  it('accepts a local QUEUE_UPDATE', () => {
    expect(
      isValidSyncMessage({
        type: 'QUEUE_UPDATE',
        queue: LOCAL_QUEUE,
        currentId: LOCAL_ITEM.id,
        currentTime: 10,
        senderId: 'host-1',
      })
    ).toBe(true);
  });

  it('accepts a local STATE_SNAPSHOT', () => {
    expect(
      isValidSyncMessage({
        type: 'STATE_SNAPSHOT',
        platform: 'local',
        videoId: LOCAL_ITEM.videoId,
        currentTime: 10,
        isPlaying: true,
        queue: LOCAL_QUEUE,
        currentId: LOCAL_ITEM.id,
        senderId: 'host-1',
      })
    ).toBe(true);
  });

  it('still accepts existing platforms without a local field', () => {
    expect(
      isValidSyncMessage({
        type: 'QUEUE_UPDATE',
        queue: QUEUE,
        currentId: QUEUE[0].id,
        currentTime: 0,
        senderId: 'host-1',
      })
    ).toBe(true);
  });

  it('ignores a stray local field on a non-local item', () => {
    expect(
      isValidSyncMessage({
        type: 'QUEUE_UPDATE',
        queue: [{ ...QUEUE[0], local: LOCAL_META }],
        currentId: QUEUE[0].id,
        currentTime: 0,
        senderId: 'host-1',
      })
    ).toBe(true);
  });

  it.each([
    ['missing local metadata', { ...LOCAL_ITEM, local: undefined }],
    ['an empty file name', { ...LOCAL_ITEM, local: { ...LOCAL_META, fileName: '' } }],
    [
      'an over-long file name',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, fileName: 'n'.repeat(256) } },
    ],
    [
      'a negative size',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, sizeBytes: -1 } },
    ],
    [
      'a non-integer size',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, sizeBytes: 1.5 } },
    ],
    [
      'a non-finite duration',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, durationSec: Infinity } },
    ],
    [
      'an over-long duration',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, durationSec: 86401 } },
    ],
    [
      'an over-long MIME type',
      { ...LOCAL_ITEM, local: { ...LOCAL_META, mimeType: 'x'.repeat(101) } },
    ],
    [
      'a path-like videoId',
      { ...LOCAL_ITEM, videoId: '../../etc/passwd' },
    ],
    ['a too-short videoId', { ...LOCAL_ITEM, videoId: 'abc' }],
  ])('rejects a local item with %s', (_label, item) => {
    expect(
      isValidSyncMessage({
        type: 'QUEUE_UPDATE',
        queue: [item],
        currentId: LOCAL_ITEM.id,
        currentTime: 0,
        senderId: 'host-1',
      })
    ).toBe(false);
  });

  it('rejects a local STATE_SNAPSHOT with an unsafe videoId', () => {
    expect(
      isValidSyncMessage({
        type: 'STATE_SNAPSHOT',
        platform: 'local',
        videoId: '../secret',
        currentTime: 0,
        isPlaying: false,
        queue: LOCAL_QUEUE,
        currentId: LOCAL_ITEM.id,
        senderId: 'host-1',
      })
    ).toBe(false);
  });
});
