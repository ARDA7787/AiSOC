// WS-D1 — pin the ExplainDrawer streaming contract.
//
// The drawer is a thin renderer over the `agentsApi.explainStream` NDJSON
// pipe, but it owns three things that the rest of the app depends on and
// that have already broken once before: (1) the abort lifecycle so a closed
// drawer doesn't keep an LLM call alive, (2) per-frame routing so a re-emitted
// MITRE card doesn't double-render, and (3) graceful fallback when the
// backend trips a rate limit or runs into a transport error.
//
// We test against a controllable `ReadableStream`: each test gets an
// `enqueue(frame)` helper and chooses exactly when to close the body. That
// keeps timing assertions deterministic without faking timers, which is the
// only way React state batches behave consistently in jsdom.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const explainStreamMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  __esModule: true,
  agentsApi: {
    explainStream: explainStreamMock,
  },
}));

// Import AFTER the mock so the component picks up our stub.
import { ExplainDrawer } from './ExplainDrawer';
import type { Alert, ExplainStreamFrame } from '@/lib/api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface MockStreamHandle {
  /** Push one NDJSON frame onto the wire. Newline is appended for you. */
  enqueue: (frame: ExplainStreamFrame) => Promise<void>;
  /** Push a raw string (used when we want a malformed line, etc.). */
  enqueueRaw: (text: string) => Promise<void>;
  /** Close the body cleanly (stream "done" from the server's POV). */
  close: () => Promise<void>;
  /** Capture the AbortSignal the drawer passed to `explainStream`. */
  signal: () => AbortSignal | undefined;
}

/**
 * Build a controllable Response whose body is a ReadableStream we can push
 * to from the test. The drawer's `getReader().read()` loop will surface
 * each chunk to `applyFrame` exactly as the real backend would.
 */
function buildMockStream(opts: {
  status?: number;
  signalCapture: { current: AbortSignal | undefined };
}): { response: Response; handle: MockStreamHandle } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const response = new Response(body, {
    status: opts.status ?? 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });

  const handle: MockStreamHandle = {
    async enqueue(frame) {
      // Wrap in act() so the React state updates inside the drawer's
      // streaming reader are flushed before the test moves on. Without
      // this we get noisy "not wrapped in act(...)" warnings even though
      // the assertions resolve correctly via waitFor().
      await act(async () => {
        controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
        await Promise.resolve();
      });
    },
    async enqueueRaw(text) {
      await act(async () => {
        controller.enqueue(encoder.encode(text));
        await Promise.resolve();
      });
    },
    async close() {
      await act(async () => {
        controller.close();
        await Promise.resolve();
      });
    },
    signal: () => opts.signalCapture.current,
  };

  return { response, handle };
}

const ALERT: Alert = {
  id: 'ALERT-WS-D1-0001',
  title: 'Impossible travel — login from Frankfurt then Tokyo',
  severity: 'high',
  source: 'okta',
  status: 'new',
  description: 'Account takeover suspected.',
  tags: ['account-takeover'],
  // The component strips `rawEvent`, so we include it to confirm.
  rawEvent: { 'do-not': 'send' },
  receivedAt: '2026-05-09T18:00:00Z',
  mitreAttack: [{ techniqueId: 'T1078' }],
  iocs: [{ type: 'ip', value: '203.0.113.42' }],
  // The remaining fields don't matter for rendering but the type wants them.
} as unknown as Alert;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExplainDrawer', () => {
  beforeEach(() => {
    explainStreamMock.mockReset();
  });

  it('returns null when closed', () => {
    const { container } = render(
      <ExplainDrawer open={false} onClose={vi.fn()} alert={ALERT} />,
    );
    // When closed the component renders nothing — no overlay, no aside.
    expect(container.firstChild).toBeNull();
    expect(explainStreamMock).not.toHaveBeenCalled();
  });

  it('renders header + sections as frames arrive and closes on done', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);

    // The drawer starts streaming immediately on open.
    await waitFor(() => {
      expect(explainStreamMock).toHaveBeenCalledTimes(1);
    });

    // Header surfaces alert metadata regardless of status.
    expect(
      screen.getByText(/Impossible travel/),
    ).toBeInTheDocument();
    expect(screen.getByText(/okta · high · ALERT-WS-D1-0001/)).toBeInTheDocument();

    // The drawer trims `rawEvent` from the payload it sends to the backend.
    const callArgs = explainStreamMock.mock.calls[0][0] as {
      alert: Record<string, unknown>;
      alertId: string;
    };
    expect(callArgs.alertId).toBe('ALERT-WS-D1-0001');
    expect(callArgs.alert).toMatchObject({ id: 'ALERT-WS-D1-0001', source: 'okta' });
    expect(callArgs.alert).not.toHaveProperty('rawEvent');

    // Push a section header + summary deltas. The summary should render
    // tokens as they arrive (this is the streaming UX).
    await handle.enqueue({ kind: 'section', id: 'summary', title: 'What happened' });
    await handle.enqueue({ kind: 'delta', section: 'summary', text: 'Two logins ' });
    await handle.enqueue({ kind: 'delta', section: 'summary', text: 'from impossible distance.' });

    await waitFor(() => {
      expect(
        screen.getByText('Two logins from impossible distance.'),
      ).toBeInTheDocument();
    });

    // OCSF section.
    await handle.enqueue({
      kind: 'ocsf',
      category: 'Identity & Access Management',
      category_uid: 3,
      class: 'Authentication',
      class_uid: 3002,
      activity: 'Logon',
      fields: { 'actor.user.name': 'alice' },
    });
    await waitFor(() => {
      expect(screen.getByText(/OCSF mapping/i)).toBeInTheDocument();
      expect(screen.getByText(/Authentication \(3002\)/)).toBeInTheDocument();
      // Field key + value should both render in the dl.
      expect(screen.getByText('actor.user.name')).toBeInTheDocument();
      expect(screen.getByText('alice')).toBeInTheDocument();
    });

    // MITRE — first card renders, then a duplicate ID is ignored.
    await handle.enqueue({
      kind: 'mitre',
      id: 'T1078',
      name: 'Valid Accounts',
      tactic_names: ['Defense Evasion', 'Initial Access'],
      description: 'Adversaries may obtain credentials.',
      url: 'https://attack.mitre.org/techniques/T1078/',
      found: true,
    });
    await handle.enqueue({
      kind: 'mitre',
      id: 'T1078',
      name: 'Valid Accounts (DUP)',
      tactic_names: [],
      description: 'should not appear',
      url: 'https://attack.mitre.org/techniques/T1078/',
      found: true,
    });
    await waitFor(() => {
      expect(screen.getAllByText('T1078')).toHaveLength(1);
      expect(screen.getByText('Valid Accounts')).toBeInTheDocument();
    });
    expect(screen.queryByText('Valid Accounts (DUP)')).not.toBeInTheDocument();
    expect(screen.queryByText('should not appear')).not.toBeInTheDocument();

    // Evidence + next-step.
    await handle.enqueue({
      kind: 'evidence',
      label: 'src_ip',
      value: '203.0.113.42',
      annotation: 'Frankfurt',
    });
    await handle.enqueue({
      kind: 'next_step',
      title: 'Force re-authentication',
      rationale: 'Invalidate active sessions for this user.',
      playbook_id: 'identity-compromise-v1',
    });

    await waitFor(() => {
      expect(screen.getByText('203.0.113.42')).toBeInTheDocument();
      expect(screen.getByText('Force re-authentication')).toBeInTheDocument();
      expect(screen.getByText('identity-compromise-v1')).toBeInTheDocument();
    });

    // Done frame flips status to "done" and surfaces the disclaimer.
    await handle.enqueue({ kind: 'done', alert_id: 'ALERT-WS-D1-0001' });
    await handle.close();

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
      expect(
        screen.getByText(/Always verify before taking action/i),
      ).toBeInTheDocument();
    });
  });

  it('aborts the in-flight stream when the drawer closes', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    const { rerender } = render(
      <ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />,
    );

    await waitFor(() => {
      expect(explainStreamMock).toHaveBeenCalled();
      expect(signalRef.current).toBeDefined();
    });
    expect(signalRef.current?.aborted).toBe(false);

    // Close the drawer — the `useEffect` cleanup should hit `abortRef.abort()`.
    rerender(<ExplainDrawer open={false} onClose={vi.fn()} alert={ALERT} />);

    await waitFor(() => {
      expect(signalRef.current?.aborted).toBe(true);
    });

    // Back-pressure check: the stream is still readable from our side, but
    // the drawer no longer reads from it (drawer is unmounted-ish in the
    // visual sense). Nothing else should crash if we close after.
    await handle.close();
  });

  it('aborts the in-flight stream on unmount', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    const { unmount } = render(
      <ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />,
    );

    await waitFor(() => {
      expect(signalRef.current).toBeDefined();
    });

    unmount();

    await waitFor(() => {
      expect(signalRef.current?.aborted).toBe(true);
    });
  });

  it('shows an error banner + Retry button on HTTP non-2xx', async () => {
    // Simulate the rate-limit response — body present, but status 429.
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            JSON.stringify({
              kind: 'error',
              error: 'rate limit exceeded; retry in 30s',
            }) + '\n',
          ),
        );
        c.close();
      },
    });
    const response = new Response(body, {
      status: 429,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Retry-After': '30',
      },
    });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);

    await waitFor(() => {
      expect(screen.getByText(/Explain endpoint returned HTTP 429/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    // Status badge should reflect the failure too.
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('surfaces a backend NDJSON error frame on a 200 stream', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);

    await waitFor(() => {
      expect(explainStreamMock).toHaveBeenCalled();
    });

    // Stream a partial summary, then an inline error — the drawer should
    // halt and show the error rather than waiting for more frames.
    await handle.enqueue({
      kind: 'delta',
      section: 'summary',
      text: 'Investigating...',
    });
    await handle.enqueue({
      kind: 'error',
      error: 'OCSF mapper unavailable; partial result returned',
    });
    await handle.close();

    await waitFor(() => {
      expect(
        screen.getByText('OCSF mapper unavailable; partial result returned'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  it('survives malformed NDJSON lines without breaking the stream', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);
    await waitFor(() => expect(explainStreamMock).toHaveBeenCalled());

    // Push a junk line first, then valid content. The good frames must
    // still render — silent drop on parse failure is the documented behavior.
    await handle.enqueueRaw('this is not json\n');
    await handle.enqueue({
      kind: 'delta',
      section: 'summary',
      text: 'Recovered.',
    });
    await handle.enqueue({ kind: 'done', alert_id: 'ALERT-WS-D1-0001' });
    await handle.close();

    await waitFor(() => {
      expect(screen.getByText('Recovered.')).toBeInTheDocument();
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
  });

  it('handles NDJSON frames split mid-line across chunks', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);
    await waitFor(() => expect(explainStreamMock).toHaveBeenCalled());

    // Classic backpressure split: half a frame, then the rest, then EOL.
    // The buffer logic in startStream must stitch these together before
    // JSON.parse, otherwise we'd lose summary text.
    const fullLine = JSON.stringify({
      kind: 'delta',
      section: 'summary',
      text: 'Hello world.',
    });
    const half = fullLine.slice(0, 18);
    const rest = fullLine.slice(18);
    await handle.enqueueRaw(half);
    await handle.enqueueRaw(rest + '\n');
    await handle.enqueue({ kind: 'done', alert_id: 'ALERT-WS-D1-0001' });
    await handle.close();

    await waitFor(() => {
      expect(screen.getByText('Hello world.')).toBeInTheDocument();
    });
  });

  it('fires onRunPlaybook with the playbook_id when "Run playbook" is clicked', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response, handle } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(
      async (_payload: unknown, signal?: AbortSignal) => {
        signalRef.current = signal;
        return response;
      },
    );

    const onRunPlaybook = vi.fn();
    const user = userEvent.setup();

    render(
      <ExplainDrawer
        open={true}
        onClose={vi.fn()}
        alert={ALERT}
        onRunPlaybook={onRunPlaybook}
      />,
    );

    await handle.enqueue({
      kind: 'next_step',
      title: 'Force re-authentication',
      rationale: 'Invalidate sessions.',
      playbook_id: 'identity-compromise-v1',
    });
    await handle.enqueue({ kind: 'done', alert_id: 'ALERT-WS-D1-0001' });
    await handle.close();

    const runBtn = await screen.findByRole('button', { name: /Run playbook/i });
    await user.click(runBtn);

    expect(onRunPlaybook).toHaveBeenCalledWith('identity-compromise-v1');
  });

  it('closes when ESC is pressed', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(async () => response);

    const onClose = vi.fn();
    render(<ExplainDrawer open={true} onClose={onClose} alert={ALERT} />);

    await waitFor(() => expect(explainStreamMock).toHaveBeenCalled());

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    document.dispatchEvent(event);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the overlay is clicked', async () => {
    const signalRef: { current: AbortSignal | undefined } = { current: undefined };
    const { response } = buildMockStream({ signalCapture: signalRef });
    explainStreamMock.mockImplementation(async () => response);

    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ExplainDrawer open={true} onClose={onClose} alert={ALERT} />);

    await waitFor(() => expect(explainStreamMock).toHaveBeenCalled());

    // Both close affordances live behind aria-label="Close" — the overlay
    // button (full-width) and the X button. We click the overlay one
    // explicitly via testid-free lookup; clicking either works the same.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
    await user.click(closeButtons[0]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking Retry restarts the stream from a fresh idle state', async () => {
    let attempt = 0;
    const signalRefs: AbortSignal[] = [];

    explainStreamMock.mockImplementation(async (_payload, signal?: AbortSignal) => {
      attempt += 1;
      if (signal) signalRefs.push(signal);
      if (attempt === 1) {
        // First attempt: 503.
        return new Response('boom', { status: 503 });
      }
      // Second attempt: a clean stream with one delta then done.
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              JSON.stringify({
                kind: 'delta',
                section: 'summary',
                text: 'Recovered after retry.',
              }) + '\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              JSON.stringify({ kind: 'done', alert_id: ALERT.id }) + '\n',
            ),
          );
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    });

    const user = userEvent.setup();
    render(<ExplainDrawer open={true} onClose={vi.fn()} alert={ALERT} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('Recovered after retry.')).toBeInTheDocument();
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    expect(attempt).toBe(2);
    expect(signalRefs).toHaveLength(2);
  });
});
