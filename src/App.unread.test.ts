import { describe, expect, it } from 'vitest';
import { computeUnreadChatCount } from './chatUnread';

describe('computeUnreadChatCount', () => {
  it('counts new messages beyond the 200-message history limit', () => {
    expect(computeUnreadChatCount(201, 200, false)).toBe(1);
  });

  it('returns 0 while the chat view is open', () => {
    expect(computeUnreadChatCount(201, 200, true)).toBe(0);
  });

  it('keeps the previous unread behavior below 200 messages', () => {
    expect(computeUnreadChatCount(0, 0, false)).toBe(0);
    expect(computeUnreadChatCount(5, 3, false)).toBe(2);
    expect(computeUnreadChatCount(3, 5, false)).toBe(0);
  });
});
