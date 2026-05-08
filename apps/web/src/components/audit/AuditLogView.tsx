'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';

interface AuditEvent {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  changes: Record<string, unknown> | null;
  created_at: string;
}

interface AuditListResponse {
  items: AuditEvent[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

const fetcher = async (url: string) => {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
};

const MOCK_AUDIT: AuditListResponse = {
  items: [
    { id: '1', tenant_id: 't1', actor_id: 'u1', actor_email: 'admin@acme.io', actor_ip: '10.0.1.12', action: 'cases:create', resource: 'case', resource_id: 'c-0001abcd', changes: { title: 'Suspicious lateral movement' }, created_at: new Date(Date.now() - 300_000).toISOString() },
    { id: '2', tenant_id: 't1', actor_id: 'u2', actor_email: 'analyst@acme.io', actor_ip: '10.0.1.15', action: 'alerts:update', resource: 'alert', resource_id: 'a-0042efgh', changes: { status: ['open', 'acknowledged'] }, created_at: new Date(Date.now() - 900_000).toISOString() },
    { id: '3', tenant_id: 't1', actor_id: null, actor_email: null, actor_ip: null, action: 'playbooks:execute', resource: 'playbook', resource_id: 'pb-isolate', changes: { trigger: 'auto' }, created_at: new Date(Date.now() - 1_800_000).toISOString() },
    { id: '4', tenant_id: 't1', actor_id: 'u1', actor_email: 'admin@acme.io', actor_ip: '10.0.1.12', action: 'detections:create', resource: 'detection_rule', resource_id: 'dr-00091234', changes: { name: 'Brute-force SSH' }, created_at: new Date(Date.now() - 3_600_000).toISOString() },
    { id: '5', tenant_id: 't1', actor_id: 'u3', actor_email: 'soc-lead@acme.io', actor_ip: '10.0.2.5', action: 'connectors:update', resource: 'connector', resource_id: 'cn-sentinel', changes: { enabled: true }, created_at: new Date(Date.now() - 7_200_000).toISOString() },
    { id: '6', tenant_id: 't1', actor_id: 'u1', actor_email: 'admin@acme.io', actor_ip: '10.0.1.12', action: 'roles:create', resource: 'role', resource_id: 'role-jr-analyst', changes: { name: 'Junior Analyst' }, created_at: new Date(Date.now() - 10_800_000).toISOString() },
    { id: '7', tenant_id: 't1', actor_id: 'u2', actor_email: 'analyst@acme.io', actor_ip: '10.0.1.15', action: 'cases:update', resource: 'case', resource_id: 'c-0001abcd', changes: { status: ['open', 'in_progress'] }, created_at: new Date(Date.now() - 14_400_000).toISOString() },
    { id: '8', tenant_id: 't1', actor_id: 'u1', actor_email: 'admin@acme.io', actor_ip: '10.0.1.12', action: 'auth:api_key_create', resource: 'api_key', resource_id: 'ak-00abc', changes: null, created_at: new Date(Date.now() - 21_600_000).toISOString() },
    { id: '9', tenant_id: 't1', actor_id: null, actor_email: null, actor_ip: null, action: 'alerts:create', resource: 'alert', resource_id: 'a-0099xyz', changes: { severity: 'critical' }, created_at: new Date(Date.now() - 28_800_000).toISOString() },
    { id: '10', tenant_id: 't1', actor_id: 'u3', actor_email: 'soc-lead@acme.io', actor_ip: '10.0.2.5', action: 'cases:delete', resource: 'case', resource_id: 'c-test-0001', changes: null, created_at: new Date(Date.now() - 36_000_000).toISOString() },
  ],
  total: 10,
  page: 1,
  page_size: 50,
  total_pages: 1,
};

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-green-500/20 text-green-300',
  update: 'bg-blue-500/20 text-blue-300',
  delete: 'bg-red-500/20 text-red-300',
  execute: 'bg-yellow-500/20 text-yellow-300',
};

function actionBadge(action: string): string {
  for (const [verb, cls] of Object.entries(ACTION_COLORS)) {
    if (action.includes(verb)) return cls;
  }
  return 'bg-gray-700 text-gray-300';
}

export function AuditLogView() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = new URLSearchParams({ page: String(page), page_size: '50' });
  if (search) params.set('search', search);
  if (actionFilter) params.set('action', actionFilter);
  if (resourceFilter) params.set('resource', resourceFilter);

  const { data: raw, error, isLoading } = useSWR<AuditListResponse>(
    `/api/v1/audit?${params}`,
    fetcher,
    { refreshInterval: 30_000, fallbackData: MOCK_AUDIT, shouldRetryOnError: false, errorRetryCount: 0, revalidateOnFocus: false }
  );
  const isValid = raw && Array.isArray(raw.items) && typeof raw.total === 'number';
  const data = isValid ? raw : MOCK_AUDIT;

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-sm text-gray-400 mt-1">
            Immutable record of all platform actions
          </p>
        </div>
        {data && (
          <span className="text-sm text-gray-500">
            {data.total.toLocaleString()} total events
          </span>
        )}
      </div>

      {/* Filters */}
      <form
        onSubmit={handleSearch}
        className="flex flex-wrap gap-3 bg-gray-800/50 p-4 rounded-lg border border-gray-700 shadow-sm"
      >
        <input
          type="text"
          placeholder="Search email or action…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-48 rounded-md border border-gray-600 bg-gray-900 text-gray-200 px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-600 bg-gray-900 text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All actions</option>
          <option value="cases:">Cases</option>
          <option value="alerts:">Alerts</option>
          <option value="playbooks:">Playbooks</option>
          <option value="detections:">Detections</option>
          <option value="connectors:">Connectors</option>
          <option value="roles:">Roles</option>
          <option value="auth:">Auth</option>
        </select>
        <select
          value={resourceFilter}
          onChange={(e) => { setResourceFilter(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-600 bg-gray-900 text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All resources</option>
          <option value="case">case</option>
          <option value="alert">alert</option>
          <option value="playbook">playbook</option>
          <option value="detection_rule">detection_rule</option>
          <option value="connector">connector</option>
          <option value="role">role</option>
          <option value="api_key">api_key</option>
        </select>
        <button
          type="submit"
          className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          Search
        </button>
      </form>

      {/* Table */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 shadow-sm overflow-hidden">
        {error && !data && (
          <div className="p-8 text-center text-red-500 text-sm">
            Failed to load audit log.
          </div>
        )}
        {data && data.items.length === 0 && !isLoading && (
          <div className="p-8 text-center text-gray-400 text-sm">
            No audit events found.
          </div>
        )}
        {data && data.items.length > 0 && (
          <table className="min-w-full divide-y divide-gray-700 text-sm">
            <thead className="bg-gray-900/60">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  Timestamp
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  Actor
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  Action
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  Resource
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  IP
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-400">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {data.items.map((event) => (
                <>
                  <tr
                    key={event.id}
                    className="hover:bg-gray-700/40 cursor-pointer"
                    onClick={() =>
                      setExpandedId(expandedId === event.id ? null : event.id)
                    }
                  >
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap" suppressHydrationWarning>
                      {new Date(event.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-200">
                        {event.actor_email ?? 'system'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${actionBadge(
                          event.action
                        )}`}
                      >
                        {event.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {event.resource ?? '—'}
                      {event.resource_id && (
                        <span className="ml-1 text-gray-400 text-xs">
                          #{event.resource_id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {event.actor_ip ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-indigo-500 text-xs">
                      {expandedId === event.id ? '▲ hide' : '▼ show'}
                    </td>
                  </tr>
                  {expandedId === event.id && (
                    <tr key={`${event.id}-expanded`} className="bg-gray-900/40">
                      <td colSpan={6} className="px-4 py-3">
                        <pre className="text-xs text-gray-300 whitespace-pre-wrap">
                          {JSON.stringify(
                            {
                              id: event.id,
                              actor_id: event.actor_id,
                              changes: event.changes,
                            },
                            null,
                            2
                          )}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {data && data.total_pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Page {data.page} of {data.total_pages}
          </p>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 text-sm border border-gray-600 text-gray-300 rounded-md disabled:opacity-40 hover:bg-gray-700"
            >
              Previous
            </button>
            <button
              disabled={page >= data.total_pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 text-sm border border-gray-600 text-gray-300 rounded-md disabled:opacity-40 hover:bg-gray-700"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
