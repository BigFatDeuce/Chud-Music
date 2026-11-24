import { AnimatePresence, motion } from 'motion/react';
import { LoaderCircle } from 'lucide-react';
import { useTasks } from '@/store/tasks';
import { useLibrary } from '@/store/library';
import { tr } from '@shared/i18n';

/** "The app is working": long operations and the library scan, above the player bar. */
export function TaskTray() {
  const tasks = useTasks((s) => s.tasks).filter((t) => t.shown);
  const scan = useLibrary((s) => s.status);
  const rows = [
    ...tasks.map((t) => ({ key: `t${t.id}`, label: t.label, done: t.done, total: t.total })),
    ...(scan.running ? [{ key: 'scan', label: tr('tasks.scan'), done: scan.parsed, total: null as number | null, note: tr('tasks.found', { n: scan.found }) }] : []),
  ];
  return (
    <div className="task-tray" aria-live="polite">
      <AnimatePresence initial={false}>
        {rows.map((r) => (
          <motion.div
            key={r.key}
            className="task panel"
            role="status"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <LoaderCircle size={16} className="spin" />
            <div className="task-text">
              <b>{r.label}</b>
              <span>{r.total ? `${r.done} / ${r.total}` : 'note' in r ? r.note : tr('common.inProgress')}</span>
              <div className={`task-bar${r.total ? '' : ' indeterminate'}`} style={{ ['--pct' as string]: r.total ? `${Math.round((r.done / r.total) * 100)}%` : '30%' }} />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
