'use client';
import { useState, useCallback } from 'react';
import { searchIssues, type IssueProvider, type NormalizedIssue, type ExternalIssueRef } from '../lib/api';

interface IssuePickerProps {
  onSelect: (ref: ExternalIssueRef, generatedPrompt: string) => void;
  onSkip: () => void;
}

const PROVIDER_LABELS: Record<IssueProvider, string> = {
  github: 'GitHub',
  linear: 'Linear',
};

export function IssuePicker({ onSelect, onSkip }: IssuePickerProps) {
  const [provider, setProvider] = useState<IssueProvider>('github');
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NormalizedIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    setError(null);
    setLoading(true);
    setSearched(true);
    try {
      const res = await searchIssues({ provider, query: query.trim() || undefined, scope: scope.trim() || undefined, limit: 25 });
      setResults(res.issues);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [provider, query, scope]);

  function handleSelect(issue: NormalizedIssue) {
    const ref: ExternalIssueRef = {
      provider: issue.provider,
      externalId: issue.externalId,
      key: issue.key,
      url: issue.url,
      title: issue.title,
    };
    const prompt = buildPrompt(issue);
    onSelect(ref, prompt);
  }

  return (
    <div className="space-y-4">
      {/* Source selector */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Link to an issue</p>
        <div className="grid grid-cols-2 gap-2">
          {(['github', 'linear'] as IssueProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => { setProvider(p); setResults([]); setSearched(false); }}
              className={`py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                provider === p
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'
              }`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Scope input */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          {provider === 'github' ? 'Repository (owner/repo)' : 'Team ID (optional)'}
        </label>
        <input
          type="text"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder={provider === 'github' ? 'e.g. owner/repo' : 'e.g. team-uuid'}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Search input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          placeholder="Search issues…"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={() => void handleSearch()}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 active:scale-95 transition-all"
        >
          {loading ? '…' : 'Search'}
        </button>
      </div>

      {error && (
        <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}

      {/* Results */}
      {searched && !loading && results.length === 0 && !error && (
        <p className="text-center text-gray-400 text-sm py-4">No issues found.</p>
      )}

      {results.length > 0 && (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
          {results.map((issue) => (
            <li key={`${issue.provider}:${issue.externalId}`}>
              <button
                type="button"
                onClick={() => handleSelect(issue)}
                className="w-full text-left px-3 py-3 hover:bg-blue-50 active:bg-blue-100 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <span className="shrink-0 text-xs font-mono text-gray-400 mt-0.5">{issue.key}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{issue.title}</p>
                    {issue.labels.length > 0 && (
                      <p className="text-xs text-gray-400 truncate mt-0.5">{issue.labels.join(', ')}</p>
                    )}
                  </div>
                  <span className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded font-medium ${
                    issue.state === 'open' || issue.state === '' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {issue.state || 'open'}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Skip */}
      <button
        type="button"
        onClick={onSkip}
        className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-1"
      >
        Skip — start from manual prompt
      </button>
    </div>
  );
}

function buildPrompt(issue: NormalizedIssue): string {
  const lines: string[] = [`Implement the following issue (${issue.key}): ${issue.title}`];
  if (issue.url) lines.push(`\nIssue URL: ${issue.url}`);
  if (issue.body?.trim()) lines.push(`\n---\n${issue.body.trim()}`);
  return lines.join('\n');
}
