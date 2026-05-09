'use client';

/**
 * PlaybooksGallery
 * ================
 * Faceted gallery for the /playbooks "All" tab. Surfaces the 50+ shipped
 * reference packs alongside any user-created playbooks with:
 *
 *   • Source filter pills      ("All" / "Shipped Packs" / "Custom")
 *   • Category facet chips     (account-takeover, ransomware, …)
 *   • Free-text search         (matches name, description, tags)
 *   • Per-row PACK badge       (purple) + colored category badge
 *   • One-click "Preview"      (read-only DAG drawer)
 *   • One-click "Fork"         (clones a pack into a user-owned playbook)
 *   • "Edit" / "Delete"        (existing flow for custom playbooks)
 *
 * The gallery is driven entirely from the existing `GET /api/v1/playbooks`
 * payload — no new backend endpoints required. See packHelpers.ts for the
 * pack-detection heuristic and forking logic.
 */

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import clsx from 'clsx';

import type { Playbook } from './types';
import {
  PACK_CATEGORIES,
  type PackCategory,
  type PlaybookSource,
  isShippedPack,
  categoryOf,
  categoryLabel,
  categoryBadgeClass,
  filterPlaybooks,
  countBySource,
  countByCategory,
  forkPlaybook,
} from './packHelpers';
import { DAGPreviewDrawer } from './DAGPreviewDrawer';
import { EnabledToggle, RunButton, deletePlaybook } from './rowActions';

const TRIGGER_COLORS: Record<string, string> = {
  alert:    'bg-red-900/40 text-red-300 border-red-800',
  case:     'bg-blue-900/40 text-blue-300 border-blue-800',
  manual:   'bg-gray-800 text-gray-400 border-gray-700',
  schedule: 'bg-purple-900/40 text-purple-300 border-purple-800',
};

interface PlaybooksGalleryProps {
  playbooks: Playbook[];
}

export function PlaybooksGallery({ playbooks }: PlaybooksGalleryProps) {
  const router = useRouter();
  const [source, setSource] = useState<PlaybookSource>('all');
  const [category, setCategory] = useState<PackCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [previewing, setPreviewing] = useState<Playbook | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<string | null>(null);

  const sourceCounts = useMemo(() => countBySource(playbooks), [playbooks]);
  const categoryCounts = useMemo(() => countByCategory(playbooks), [playbooks]);
  const filtered = useMemo(
    () => filterPlaybooks(playbooks, { source, category, search }),
    [playbooks, source, category, search],
  );

  // The category facet only meaningfully applies to packs.
  const showCategoryRow = source !== 'custom';

  async function handleFork(pb: Playbook) {
    setForkError(null);
    setForkingId(pb.id);
    try {
      const created = await forkPlaybook(pb);
      // Refresh the gallery list so the fork shows up under "Custom".
      await mutate('/api/v1/playbooks');
      // Drop the user into the editor for their fresh fork.
      setPreviewing(null);
      router.push(`/playbooks/${created.id}`);
    } catch (e) {
      setForkError(e instanceof Error ? e.message : 'Fork failed.');
    } finally {
      setForkingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar — search + source pills */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-1 min-w-[220px] gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search playbooks by name, tag, description…"
            aria-label="Search playbooks"
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div
          className="flex gap-1 rounded-lg border border-gray-700 bg-gray-900 p-1"
          role="tablist"
          aria-label="Playbook source"
        >
          <SourcePill
            label="All"
            count={sourceCounts.all}
            active={source === 'all'}
            onClick={() => setSource('all')}
          />
          <SourcePill
            label="Shipped Packs"
            count={sourceCounts.pack}
            active={source === 'pack'}
            onClick={() => setSource('pack')}
            tone="pack"
          />
          <SourcePill
            label="Custom"
            count={sourceCounts.custom}
            active={source === 'custom'}
            onClick={() => setSource('custom')}
          />
        </div>
      </div>

      {/* Category facet (only when a category is meaningful) */}
      {showCategoryRow && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filter by category">
          <CategoryPill
            label="All categories"
            active={category === 'all'}
            onClick={() => setCategory('all')}
          />
          {PACK_CATEGORIES.map((cat) => {
            const n = categoryCounts[cat];
            if (n === 0) return null;
            return (
              <CategoryPill
                key={cat}
                label={`${categoryLabel(cat)} (${n})`}
                active={category === cat}
                onClick={() => setCategory(cat)}
                tone={cat}
              />
            );
          })}
        </div>
      )}

      {forkError && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-2 text-xs text-red-200"
        >
          {forkError}
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="text-lg font-medium text-gray-400 mb-2">No matching playbooks</div>
          <div className="text-sm text-gray-600 mb-6">
            Try clearing your filters, or create a new playbook from scratch.
          </div>
          <Link
            href="/playbooks/new"
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors"
          >
            Create a playbook
          </Link>
        </div>
      )}

      {/* List */}
      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((pb) => (
            <PlaybookRow
              key={pb.id}
              playbook={pb}
              forking={forkingId === pb.id}
              onPreview={() => setPreviewing(pb)}
              onFork={() => handleFork(pb)}
            />
          ))}
        </div>
      )}

      <DAGPreviewDrawer
        playbook={previewing}
        onClose={() => setPreviewing(null)}
        onFork={(pb) => handleFork(pb)}
        forking={forkingId !== null}
      />
    </div>
  );
}

/* ─────────────────────────── Source / Category pills ─────────────────────────── */

function SourcePill({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: 'pack';
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
        active
          ? tone === 'pack'
            ? 'bg-purple-700 text-white'
            : 'bg-blue-600 text-white'
          : 'text-gray-400 hover:text-gray-200',
      )}
    >
      {label} ({count})
    </button>
  );
}

function CategoryPill({
  label,
  active,
  onClick,
  tone,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: PackCategory;
}) {
  const activeClasses = tone ? categoryBadgeClass(tone) : 'bg-blue-900/40 text-blue-200 border-blue-700';
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
        active ? activeClasses : 'border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-700',
      )}
    >
      {label}
    </button>
  );
}

/* ─────────────────────────── Row ─────────────────────────── */

function PlaybookRow({
  playbook,
  forking,
  onPreview,
  onFork,
}: {
  playbook: Playbook;
  forking: boolean;
  onPreview: () => void;
  onFork: () => void;
}) {
  const isPack = isShippedPack(playbook);
  const cat = categoryOf(playbook);
  const triggerOn = playbook.trigger?.on ?? 'manual';

  return (
    <div
      className={clsx(
        'bg-gray-900/60 border rounded-xl px-5 py-4 flex items-center gap-4 transition-colors',
        playbook.enabled ? 'border-gray-800 hover:border-gray-700' : 'border-gray-800/40 opacity-70',
      )}
    >
      <EnabledToggle playbook={playbook} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {isPack && (
            <span
              className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded border border-purple-700/60 bg-purple-900/40 text-purple-200"
              title="Shipped reference pack — fork to customize."
            >
              PACK
            </span>
          )}
          {cat && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border ${categoryBadgeClass(cat)}`}
              title={`Category: ${categoryLabel(cat)}`}
            >
              {categoryLabel(cat)}
            </span>
          )}
          <Link
            href={`/playbooks/${playbook.id}`}
            className="text-white font-medium hover:text-blue-300 transition-colors truncate"
          >
            {playbook.name}
          </Link>
          <span
            className={`text-xs px-2 py-0.5 rounded border ${
              TRIGGER_COLORS[triggerOn] ?? TRIGGER_COLORS.manual
            }`}
          >
            {triggerOn}
          </span>
          {!playbook.enabled && (
            <span className="text-xs px-1.5 py-0.5 rounded border border-gray-700 text-gray-500">
              disabled
            </span>
          )}
        </div>
        {playbook.description && (
          <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{playbook.description}</p>
        )}
        <div className="flex items-center gap-3 mt-1 text-xs text-gray-700">
          <span>{playbook.steps.length} steps</span>
          <span>v{playbook.version}</span>
          {playbook.author && <span>by {playbook.author}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <RunButton playbook={playbook} />
        <button
          onClick={onPreview}
          aria-label={`Preview DAG for ${playbook.name}`}
          className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:text-blue-300 hover:border-blue-800 transition-colors"
        >
          Preview
        </button>
        {isPack ? (
          <button
            onClick={onFork}
            disabled={forking}
            aria-label={`Fork ${playbook.name}`}
            className="text-xs px-2.5 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white transition-colors disabled:opacity-50"
          >
            {forking ? 'Forking…' : 'Fork'}
          </button>
        ) : (
          <>
            <Link
              href={`/playbooks/${playbook.id}`}
              className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
            >
              Edit
            </Link>
            <button
              onClick={() => deletePlaybook(playbook.id)}
              className="text-xs px-2.5 py-1 rounded border border-gray-800 text-gray-600 hover:text-red-400 hover:border-red-900 transition-colors"
              aria-label={`Delete ${playbook.name}`}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
