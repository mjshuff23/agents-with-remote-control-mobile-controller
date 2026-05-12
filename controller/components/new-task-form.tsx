'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTask, type ExternalIssueRef } from '../lib/api';
import { IssuePicker } from './issue-picker';
import { LinkedIssueBadge } from './linked-issue-badge';

type Step = 'pick' | 'form';

export function NewTaskForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('pick');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [linkedIssue, setLinkedIssue] = useState<ExternalIssueRef | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleIssueSelected(ref: ExternalIssueRef, generatedPrompt: string) {
    setLinkedIssue(ref);
    setPrompt(generatedPrompt);
    if (!title && ref.title) setTitle(ref.title.slice(0, 160));
    setStep('form');
  }

  function handleSkip() {
    setLinkedIssue(null);
    setStep('form');
  }

  function handleClearIssue() {
    setLinkedIssue(null);
    setPrompt('');
    setTitle('');
    setStep('pick');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) {
      setError('Prompt is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { task } = await createTask({
        prompt: prompt.trim(),
        agent: 'codex',
        title: title.trim() || undefined,
        externalIssueRef: linkedIssue ?? undefined,
      });
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error. Is the backend running?');
      setLoading(false);
    }
  }

  if (step === 'pick') {
    return <IssuePicker onSelect={handleIssueSelected} onSkip={handleSkip} />;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Linked issue badge or re-link button */}
      {linkedIssue ? (
        <LinkedIssueBadge ref_={linkedIssue} onClear={handleClearIssue} />
      ) : (
        <button
          type="button"
          onClick={() => setStep('pick')}
          className="w-full text-left text-sm text-blue-600 hover:text-blue-800 border border-dashed border-blue-300 rounded-lg px-3 py-2"
        >
          + Link to a GitHub or Linear issue
        </button>
      )}

      <div>
        <label htmlFor="task-title" className="block text-sm font-medium text-gray-700 mb-1.5">
          Title <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          id="task-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Add unit tests for auth module"
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="task-prompt" className="block text-sm font-medium text-gray-700 mb-1.5">
          Prompt <span className="text-red-400">*</span>
        </label>
        <textarea
          id="task-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={7}
          placeholder="Describe what you want Codex to do in detail…"
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </div>

      {error && (
        <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all"
      >
        {loading ? 'Starting task…' : 'Start Task'}
      </button>
    </form>
  );
}
