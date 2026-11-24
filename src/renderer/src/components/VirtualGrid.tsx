import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePageScroll } from './PageScroll';

/**
 * A grid of cards where only the rows in sight exist in the page. A library can hold thousands of
 * albums or artists: drawing them all at once (each with its cover decoded) used to eat memory
 * until the window crashed, notably on Linux. The page's own scroll is used (PageScroll), like
 * TrackList; rows are measured once drawn, so cards keep their natural height.
 */
export function VirtualGrid<T>({
  items,
  minWidth,
  gap,
  rowGap = gap,
  estimate,
  className,
  itemKey,
  render,
}: {
  items: T[];
  /** Smallest card width (px): as many columns as fit. */
  minWidth: number;
  gap: number;
  rowGap?: number;
  /** First guess of a row's height from the column width (before it is measured). */
  estimate: (colWidth: number) => number;
  className: string;
  itemKey: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  const scrollEl = usePageScroll();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !scrollEl) return;
    const measure = () => {
      setWidth(el.clientWidth);
      const m = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      setMargin((old) => (Math.abs(old - m) > 1 ? m : old));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(scrollEl.firstElementChild ?? scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);

  const cols = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const colWidth = width ? (width - gap * (cols - 1)) / cols : minWidth;
  const rows = Math.ceil(items.length / cols);

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimate(colWidth) + rowGap,
    overscan: 3,
    scrollMargin: margin,
  });
  // a new column count changes every row's content: measured again
  useLayoutEffect(() => virt.measure(), [cols, virt]);

  return (
    <div ref={ref} className={`vgrid ${className}`} style={{ height: virt.getTotalSize(), position: 'relative' }}>
      {width > 0 &&
        virt.getVirtualItems().map((v) => (
          <div
            key={v.key}
            data-index={v.index}
            ref={virt.measureElement}
            className="vgrid-row"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${v.start - margin}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              columnGap: gap,
              paddingBottom: rowGap,
            }}
          >
            {items.slice(v.index * cols, v.index * cols + cols).map((it) => (
              <div key={itemKey(it)} className="vgrid-cell" style={{ minWidth: 0 }}>
                {render(it)}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
