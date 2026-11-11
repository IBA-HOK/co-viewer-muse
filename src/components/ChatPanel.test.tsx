import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatPanel from './ChatPanel';

const msgs = [
  { id: 'a-1', peerId: 'peer-a', name: 'ALICE', text: 'hello', timestamp: Date.now() - 60000 },
  { id: 'b-1', peerId: 'me', name: 'ME', text: 'hi there', timestamp: Date.now() },
];

const longMsg = {
  id: 'a-2',
  peerId: 'peer-a',
  name: 'ALICE',
  text: 'a long message '.repeat(20),
  timestamp: Date.now(),
};

function setScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

function getList(container: HTMLElement): HTMLElement {
  const list = container.querySelector('div.overflow-y-auto');
  expect(list).toBeTruthy();
  return list as HTMLElement;
}

describe('ChatPanel', () => {
  it('renders Messenger bubbles with own/other alignment, no expand step', () => {
    render(<ChatPanel messages={msgs} myId="me" onSend={() => {}} />);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('hi there')).toBeTruthy();
    expect(screen.getByPlaceholderText('MESSAGE...')).toBeTruthy();
    const ownRow = screen.getByText('hi there').closest('div.justify-end');
    const otherRow = screen.getByText('hello').closest('div.justify-start');
    expect(ownRow).toBeTruthy();
    expect(otherRow).toBeTruthy();
    expect(ownRow?.className).toMatch(/chat-msg-enter/);
  });

  it('pins the input row to the screen bottom', () => {
    render(<ChatPanel messages={msgs} myId="me" onSend={() => {}} />);
    const input = screen.getByPlaceholderText('MESSAGE...');
    const row = input.closest('div.sticky');
    expect(row).toBeTruthy();
    expect(row?.className).toMatch(/bottom-0/);
  });

  it('fills the viewport in fillViewport mode', () => {
    const { container } = render(<ChatPanel messages={msgs} myId="me" onSend={() => {}} fillViewport />);
    expect(container.firstChild).toBeTruthy();
    expect((container.firstChild as HTMLElement).className).toMatch(/flex-1/);
  });

  it('shows empty state when no messages', () => {
    render(<ChatPanel messages={[]} myId="me" onSend={() => {}} />);
    expect(screen.getByText('NO MESSAGES YET')).toBeTruthy();
  });

  it('auto-scrolls on a tall new message when already at the bottom', () => {
    const { container, rerender } = render(
      <ChatPanel messages={msgs} myId="me" onSend={() => {}} />,
    );
    const list = getList(container);
    setScrollMetrics(list, 600, 300);
    list.scrollTop = 300;
    fireEvent.scroll(list);

    setScrollMetrics(list, 900, 300);
    rerender(<ChatPanel messages={[...msgs, longMsg]} myId="me" onSend={() => {}} />);

    expect(list.scrollTop).toBe(900);
  });

  it('does not auto-scroll on a new message when scrolled up', () => {
    const { container, rerender } = render(
      <ChatPanel messages={msgs} myId="me" onSend={() => {}} />,
    );
    const list = getList(container);
    setScrollMetrics(list, 600, 300);
    list.scrollTop = 50;
    fireEvent.scroll(list);

    setScrollMetrics(list, 900, 300);
    rerender(<ChatPanel messages={[...msgs, longMsg]} myId="me" onSend={() => {}} />);

    expect(list.scrollTop).toBe(50);
  });

  it('scrolls to the bottom after sending an own message', () => {
    const onSend = vi.fn();
    const { container, rerender } = render(
      <ChatPanel messages={msgs} myId="me" onSend={onSend} />,
    );
    const list = getList(container);
    setScrollMetrics(list, 600, 300);
    list.scrollTop = 50;
    fireEvent.scroll(list);

    const input = screen.getByPlaceholderText('MESSAGE...');
    fireEvent.change(input, { target: { value: 'new own message' } });
    fireEvent.click(screen.getByText('SEND'));
    expect(onSend).toHaveBeenCalledWith('new own message');

    const ownMsg = {
      id: 'me-2',
      peerId: 'me',
      name: 'ME',
      text: 'new own message',
      timestamp: Date.now(),
    };
    setScrollMetrics(list, 900, 300);
    rerender(<ChatPanel messages={[...msgs, ownMsg]} myId="me" onSend={onSend} />);

    expect(list.scrollTop).toBe(900);
  });

  it('sends via SEND button and Enter, ignores empty input', () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} myId="me" onSend={onSend} />);
    const input = screen.getByPlaceholderText('MESSAGE...') as HTMLInputElement;
    fireEvent.click(screen.getByText('SEND'));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  test msg  ' } });
    fireEvent.click(screen.getByText('SEND'));
    expect(onSend).toHaveBeenCalledWith('test msg');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'via enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('via enter');
  });
});
