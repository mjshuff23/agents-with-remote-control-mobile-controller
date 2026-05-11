'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listTasks, type Task } from '../lib/api';
import { TaskList } from '../components/task-list';

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setError(null);
    listTasks()
      .then(({ tasks }) => setTasks(tasks))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load tasks'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
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
