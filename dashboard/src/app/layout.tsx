import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Issue Flow Dashboard',
  description: 'AI agent workflow observability dashboard'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
