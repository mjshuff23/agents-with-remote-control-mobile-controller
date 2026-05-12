'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listTasks, type Task } from '../lib/api';
import { TaskList } from '../components/task-list';

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;

    listTasks()
      .then(({ tasks }) => { if (!stale) { setTasks(tasks); setLoading(false); } })
      .catch((err) => { if (!stale) { setError(err instanceof Error ? err.message : 'Failed to load tasks'); setLoading(false); } });

    const id = setInterval(() => {
      listTasks()
        .then(({ tasks }) => { if (!stale) setTasks(tasks); })
        .catch((err) => { if (!stale) setError(err instanceof Error ? err.message : 'Failed to load tasks'); });
    }, 5_000);

    return () => { stale = true; clearInterval(id); };
  }, []);

  return (
    <main className="max-w-2xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">Tasks</h1>
        <Link
          href="/new-task"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 active:scale-95 transition-transform"
        >
          + New Task
        </Link>
      </div>
      {loading ? (
        <p className="text-center text-gray-400 py-12 text-sm">Loading…</p>
      ) : error ? (
        <p className="text-center text-red-600 py-12 text-sm">{error}</p>
      ) : (
        <TaskList tasks={tasks} />
      )}
    </main>
  );
}
