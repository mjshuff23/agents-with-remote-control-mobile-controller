import { NewTaskForm } from '../../components/new-task-form';
import Link from 'next/link';

export default function NewTaskPage() {
  return (
    <main className="max-w-2xl mx-auto p-4">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="text-gray-400 hover:text-gray-600 text-xl leading-none">←</Link>
        <h1 className="text-xl font-bold">New Task</h1>
      </div>
      <NewTaskForm />
    </main>
  );
}
