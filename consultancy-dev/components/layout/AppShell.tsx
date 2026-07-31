'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes or we leave mobile.
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [pathname, isMobile]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar
        isOpen={isSidebarOpen}
        isMobile={isMobile}
        onCloseMobile={() => setIsSidebarOpen(false)}
        isCollapsed={isSidebarCollapsed}
        toggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />

      <div className="flex-1 flex flex-col min-w-0 w-full">
        <Topbar onMenuClick={() => setIsSidebarOpen(true)} />
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1600px] mx-auto w-full min-w-0">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
