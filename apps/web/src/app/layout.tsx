import type { Metadata } from 'next';
import { Suspense } from 'react';
import { IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import { AppShell } from '@/components/app-shell';
import { LoadingBlock } from '@/components/ui';
import './globals.css';

const plex = IBM_Plex_Sans({ variable: '--font-plex', subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600', '700'] });
const mono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600'] });

export const metadata: Metadata = {
  title: { default: 'MCP Builder', template: '%s · MCP Builder' },
  description: 'Turn existing APIs into MCP servers and CLIs for AI agents.',
};

// Runs before first paint so the stored theme never flashes.
const themeScript = `try{if(localStorage.getItem('mf-theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${plex.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Suspense fallback={<LoadingBlock />}>
          <AppShell>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
