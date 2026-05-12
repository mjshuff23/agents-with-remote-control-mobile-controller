'use client';
import Link from 'next/link';
import type { Task } from '../lib/api';

const STATUS_COLOR: Record<string, string> = {
  running: 'bg-blue-500',
  starting: 'bg-blue-300',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  stopped: 'bg-gray-400',
  stopping: 'bg-orange-400',
  queued: 'bg-yellow-400',
  dormant: 'bg-purple-500',
  waiting_approval: 'bg-amber-500'
};

export function TaskList({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-center text-gray-400 py-12 text-sm">
        No tasks yet — tap <strong>+ New Task</strong> to start.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-gray-100">
      {tasks.map((task) => (
        <li key={task.id}>
          <Link
            href={`/tasks/${task.id}`}
            className="flex items-center justify-between p-4 hover:bg-white active:bg-gray-100 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-900 truncate">
                {task.title ?? task.prompt.slice(0, 60)}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {new Date(task.createdAt).toLocaleString()} · {task.selectedAgent}
              </p>
            </div>
            <span
              className={`ml-3 shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold text-white ${STATUS_COLOR[task.status] ?? 'bg-gray-400'}`}
            >
              {task.status}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
