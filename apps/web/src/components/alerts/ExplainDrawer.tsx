'use client';

/**
 * ExplainDrawer
 * =============
 *
 * Right-edge slide-over that streams an OCSF + MITRE-grounded explanation
 * of a single alert. Backed by `services/agents` ` POST /api/v1/explain`
 * (NDJSON stream).
 *
 * Why a drawer instead of inline?
 * -------------------------------
 * The alert detail page is already dense. A drawer keeps the alert grid
 * intact while the analyst is still in the middle of reading the row, and
 * gives us room for ATT&CK technique cards (which want their own width).
 *
 * Streaming model
 * ---------------
 * Each line of the response body is one {@link ExplainStreamFrame}. The
 * drawer routes by `kind`:
 *
 *   - `section` opens a new section (summary / ocsf / mitre / evidence /
 *     next) so the renderer can show a heading even before any content
 *     has arrived. This avoids the "blank drawer for 800ms" flash.
 *   - `delta` (only for the summary) appends a token. Buffered into one
 *     state field so React doesn't re-render per word.
 *   - `ocsf`, `mitre`, `evidence`, `next_step` are typed records.
 *   - `done` closes the stream cleanly.
 *   - `error` aborts and shows the message.
 *
 * Cancellation
 * ------------
 * We use an `AbortController` that fires on close + on unmount. This
 * guarantees that closing the drawer also aborts an in-flight LLM call,
 * which is important when the user clicks Explain on the wrong alert and
 * immediately closes it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentsApi,
  type Alert,
  type ExplainEvidenceFrame,
  type ExplainMitreFrame,
  type ExplainNextStepFrame,
  type ExplainOcsfFrame,
  type ExplainStreamFrame,
} from '@/lib/api';
import { clsx } from 'clsx';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface ExplainDrawerProps {
  /** Whether the drawer is currently visible. */
  open: boolean;
  /** Called when the user requests to close (overlay click, ESC, X). */
  onClose: () => void;
  /** Source alert. We pass the full record to the backend. */
  alert: Alert;
  /**
   * Optional callback when the user clicks "Run playbook" inside a
   * recommended next-step card. The parent owns the actual run logic so
   * the drawer stays presentational.
   */
  onRunPlaybook?: (playbookId: string) => void;
}

// ─── Internal state shape ────────────────────────────────────────────────────
//
// We keep everything keyed by section so frames can arrive in any order
// without breaking the render. (The backend sends them in canonical order
// today, but treating order as a hint not a contract makes this resilient
// when we layer caching or replay later.)

interface DrawerState {
  status: 'idle' | 'loading' | 'streaming' | 'done' | 'error';
  error?: string;
  summary: string;
  ocsf?: ExplainOcsfFrame;
  mitre: ExplainMitreFrame[];
  evidence: ExplainEvidenceFrame[];
  nextSteps: ExplainNextStepFrame[];
}

const INITIAL: DrawerState = {
  status: 'idle',
  summary: '',
  mitre: [],
  evidence: [],
  nextSteps: [],
};

// ─── Component ───────────────────────────────────────────────────────────────

export function ExplainDrawer({
  open,
  onClose,
  alert,
  onRunPlaybook,
}: ExplainDrawerProps) {
  const [state, setState] = useState<DrawerState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  // The alert object we send to the backend. We strip large fields the
  // server doesn't need so the request stays lean.
  const alertPayload = useMemo(() => {
    const { rawEvent: _rawEvent, ...rest } = alert as Alert & {
      rawEvent?: unknown;
    };
    return rest as unknown as Record<string, unknown>;
  }, [alert]);

  const startStream = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState({ ...INITIAL, status: 'loading' });

    try {
      const response = await agentsApi.explainStream(
        { alert: alertPayload, alertId: alert.id },
        ctrl.signal,
      );

      if (!response.ok || !response.body) {
        throw new Error(`Explain endpoint returned HTTP ${response.status}`);
      }

      setState((s) => ({ ...s, status: 'streaming' }));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // NDJSON parse loop. Same pattern as ContextualActions.tsx — read
      // chunks, split on newlines, JSON.parse each line, ignore empty
      // lines. Buffering across chunks keeps us safe when a frame is
      // split mid-line by the network layer.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;

          let frame: ExplainStreamFrame;
          try {
            frame = JSON.parse(line) as ExplainStreamFrame;
          } catch {
            continue;
          }

          setState((s) => applyFrame(s, frame));
          if (frame.kind === 'error' || frame.kind === 'done') return;
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setState((s) => ({
        ...s,
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Failed to load explanation.',
      }));
    }
  }, [alert.id, alertPayload]);

  // Open / close lifecycle. Restarts the stream on every open so the
  // drawer is always fresh — alert state changes between opens.
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      return;
    }
    void startStream();
    return () => {
      abortRef.current?.abort();
    };
  }, [open, startStream]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Click-to-close overlay. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />

      {/* Drawer panel. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Explain alert"
        className="w-full max-w-2xl h-full bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col"
      >
        <DrawerHeader
          alert={alert}
          status={state.status}
          onClose={onClose}
          onRetry={state.status === 'error' ? startStream : undefined}
        />

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {state.status === 'error' && (
            <ErrorBanner message={state.error || 'Unknown error'} />
          )}

          <SummarySection text={state.summary} status={state.status} />

          {state.ocsf && <OcsfSection frame={state.ocsf} />}

          {state.mitre.length > 0 && (
            <MitreSection cards={state.mitre} />
          )}

          {state.evidence.length > 0 && (
            <EvidenceSection items={state.evidence} />
          )}

          {state.nextSteps.length > 0 && (
            <NextStepsSection
              steps={state.nextSteps}
              onRunPlaybook={onRunPlaybook}
            />
          )}

          {state.status === 'done' && (
            <div className="text-xs text-gray-500 text-center pt-2">
              Generated by AiSOC. Always verify before taking action.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── Frame reducer ───────────────────────────────────────────────────────────

function applyFrame(state: DrawerState, frame: ExplainStreamFrame): DrawerState {
  switch (frame.kind) {
    case 'section':
      // Sections themselves carry no content — we render the heading
      // implicitly when their array becomes non-empty. Nothing to merge.
      return state;
    case 'delta':
      return { ...state, summary: state.summary + frame.text };
    case 'ocsf':
      return { ...state, ocsf: frame };
    case 'mitre':
      // Dedupe by ID so a re-emitted card doesn't double-render.
      if (state.mitre.some((m) => m.id === frame.id)) return state;
      return { ...state, mitre: [...state.mitre, frame] };
    case 'evidence':
      return { ...state, evidence: [...state.evidence, frame] };
    case 'next_step':
      return { ...state, nextSteps: [...state.nextSteps, frame] };
    case 'done':
      return { ...state, status: 'done' };
    case 'error':
      return { ...state, status: 'error', error: frame.error };
    default:
      return state;
  }
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function DrawerHeader({
  alert,
  status,
  onClose,
  onRetry,
}: {
  alert: Alert;
  status: DrawerState['status'];
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-start justify-between border-b border-gray-800 px-6 py-4 bg-gradient-to-r from-blue-500/10 to-purple-500/10">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">
            Explain
          </span>
          <StatusBadge status={status} />
        </div>
        <h2 className="text-lg font-semibold text-gray-100 truncate">
          {alert.title}
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          {alert.source} · {alert.severity} · {alert.id}
        </p>
      </div>

      <div className="flex items-center gap-2 ml-4">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs px-3 py-1.5 rounded-md bg-gray-800 text-gray-200 hover:bg-gray-700 transition"
          >
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-gray-400 hover:text-gray-100 transition p-1"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: DrawerState['status'] }) {
  const map: Record<DrawerState['status'], { label: string; cls: string }> = {
    idle: { label: 'Idle', cls: 'bg-gray-500/10 text-gray-400 ring-gray-500/20' },
    loading: {
      label: 'Loading…',
      cls: 'bg-blue-500/10 text-blue-300 ring-blue-500/20',
    },
    streaming: {
      label: 'Streaming',
      cls: 'bg-blue-500/10 text-blue-300 ring-blue-500/20',
    },
    done: {
      label: 'Done',
      cls: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
    },
    error: { label: 'Error', cls: 'bg-red-500/10 text-red-400 ring-red-500/20' },
  };
  const { label, cls } = map[status];
  return (
    <span
      className={clsx(
        'text-[10px] font-mono px-2 py-0.5 rounded ring-1 ring-inset',
        cls,
      )}
    >
      {label}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">
      {message}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
      {children}
    </h3>
  );
}

function SummarySection({
  text,
  status,
}: {
  text: string;
  status: DrawerState['status'];
}) {
  const showCursor = status === 'loading' || status === 'streaming';
  return (
    <section>
      <SectionHeading>What happened</SectionHeading>
      <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
        {text || (status === 'loading' ? 'Generating explanation…' : '—')}
        {showCursor && text && (
          <span className="inline-block w-1.5 h-4 ml-0.5 bg-blue-400 animate-pulse align-middle" />
        )}
      </p>
    </section>
  );
}

function OcsfSection({ frame }: { frame: ExplainOcsfFrame }) {
  const hasFields = Object.keys(frame.fields || {}).length > 0;
  return (
    <section>
      <SectionHeading>OCSF mapping</SectionHeading>
      <div className="rounded-md border border-gray-800 bg-gray-900/60 p-4 space-y-2">
        <div className="flex flex-wrap gap-3 text-xs">
          <Tag label="Category" value={`${frame.category} (${frame.category_uid})`} />
          <Tag label="Class" value={`${frame.class} (${frame.class_uid})`} />
          <Tag label="Activity" value={frame.activity} />
        </div>
        {hasFields && (
          <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 text-xs pt-2 border-t border-gray-800/80">
            {Object.entries(frame.fields).map(([k, v]) => (
              <FieldRow key={k} label={k} value={String(v)} />
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

function MitreSection({ cards }: { cards: ExplainMitreFrame[] }) {
  return (
    <section>
      <SectionHeading>MITRE ATT&CK</SectionHeading>
      <div className="space-y-2">
        {cards.map((c) => (
          <a
            key={c.id}
            href={c.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block rounded-md border border-purple-500/20 bg-purple-500/5 p-3 hover:bg-purple-500/10 transition"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded">
                {c.id}
              </span>
              <span className="text-sm font-medium text-gray-100">{c.name}</span>
              {!c.found && (
                <span className="text-[10px] text-amber-400 ml-auto">
                  corpus unavailable
                </span>
              )}
            </div>
            {c.tactic_names.length > 0 && (
              <div className="text-xs text-gray-400 mb-1">
                Tactics: {c.tactic_names.join(', ')}
              </div>
            )}
            {c.description && (
              <p className="text-xs text-gray-300 leading-relaxed">
                {c.description}
              </p>
            )}
          </a>
        ))}
      </div>
    </section>
  );
}

function EvidenceSection({ items }: { items: ExplainEvidenceFrame[] }) {
  return (
    <section>
      <SectionHeading>Key evidence</SectionHeading>
      <ul className="space-y-1.5">
        {items.map((e, i) => (
          <li
            key={`${e.label}-${i}`}
            className="flex items-baseline gap-3 text-sm"
          >
            <span className="text-xs text-gray-500 min-w-[100px]">
              {e.label}
            </span>
            <span className="font-mono text-gray-100 break-all">
              {e.value}
            </span>
            {e.annotation && (
              <span className="text-xs text-gray-400 ml-auto">
                {e.annotation}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextStepsSection({
  steps,
  onRunPlaybook,
}: {
  steps: ExplainNextStepFrame[];
  onRunPlaybook?: (playbookId: string) => void;
}) {
  return (
    <section>
      <SectionHeading>Next steps</SectionHeading>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div
            key={`${s.title}-${i}`}
            className="rounded-md border border-gray-800 bg-gray-900/60 p-3"
          >
            <div className="flex items-start justify-between gap-2 mb-1">
              <h4 className="text-sm font-medium text-gray-100">{s.title}</h4>
              {s.playbook_id && onRunPlaybook && (
                <button
                  type="button"
                  onClick={() => onRunPlaybook(s.playbook_id!)}
                  className="text-xs px-2.5 py-1 rounded bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 ring-1 ring-inset ring-blue-500/30 transition"
                >
                  Run playbook
                </button>
              )}
            </div>
            <p className="text-xs text-gray-300 leading-relaxed">
              {s.rationale}
            </p>
            {s.playbook_id && (
              <div className="text-[10px] font-mono text-gray-500 mt-1">
                {s.playbook_id}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Tiny presentational atoms ───────────────────────────────────────────────

function Tag({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-medium">{value}</span>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-gray-500 font-mono">{label}</dt>
      <dd className="text-gray-200 font-mono break-all">{value}</dd>
    </>
  );
}
