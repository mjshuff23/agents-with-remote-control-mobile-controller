import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ARC Controller',
  description: 'Agents With Remote Control'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen" suppressHydrationWarning>
        <header className="bg-white border-b px-4 py-3 flex items-center gap-2 sticky top-0 z-10">
          <span className="text-lg font-bold tracking-tight">ARC</span>
          <span className="text-xs text-gray-400 uppercase tracking-widest">Controller</span>
        </header>
        {children}
      </body>
    </html>
  );
}
