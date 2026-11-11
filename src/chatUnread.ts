/** Unread chat count derived from the monotonic chat sequence, not the length of the trimmed array. */
export function computeUnreadChatCount(
  chatSeq: number,
  lastSeenChatSeq: number,
  viewingChat: boolean
): number {
  return viewingChat ? 0 : Math.max(0, chatSeq - lastSeenChatSeq);
}
