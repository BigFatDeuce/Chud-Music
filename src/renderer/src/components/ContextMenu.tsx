import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
}

interface MenuState {
  open: { x: number; y: number; items: MenuItem[] } | null;
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null }),
}));

export const showMenu = (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => {
  e.preventDefault();
  useMenu.getState().show(e.clientX, e.clientY, items);
};

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);

  // keep the menu inside the window
  useLayoutEffect(() => {
    // layout size, not the bounding box: the opening animation scales the menu down a little
    const el = ref.current!;
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)), y: Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) });
  }, [x, y]);

  return (
    <motion.div
      ref={ref}
      className="menu panel"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.12 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? ' danger' : ''}${sub?.index === i ? ' open' : ''}`}
            disabled={it.disabled}
            onMouseEnter={(e) => {
              if (it.submenu) {
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ index: i, x: r.right - 4, y: r.top - 6 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.submenu) return;
              it.onSelect?.();
              onDone();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.submenu && <ChevronRight size={14} />}
          </button>
        ),
      )}
      {sub && items[sub.index]?.submenu && <MenuList items={items[sub.index]!.submenu!} x={sub.x} y={sub.y} onDone={onDone} />}
    </motion.div>
  );
}

export function ContextMenuHost() {
  const { open, hide } = useMenu();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (e.target as HTMLElement).closest('.menu')) return;
      hide();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);
  return <AnimatePresence>{open && <MenuList key={`${open.x},${open.y}`} items={open.items} x={open.x} y={open.y} onDone={hide} />}</AnimatePresence>;
}
