import { createContext, useContext, useState, type ReactNode } from 'react';

// Each view has exactly one scroll container (no nested scrollbars). Virtualized lists
// inside a page need that element, so the page publishes it through this context.

const ScrollCtx = createContext<HTMLDivElement | null>(null);
export const usePageScroll = () => useContext(ScrollCtx);

export function PageScroll({ children, className = '' }: { children: ReactNode; className?: string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setEl} className={`page ${className}`}>
      <ScrollCtx.Provider value={el}>{children}</ScrollCtx.Provider>
    </div>
  );
}
