import { create } from 'zustand';

// Long operations the user started (adding a folder to a playlist, importing…), shown in the
// activity tray so it is clear the app is working. A task only appears after a short delay,
// so quick ones do not flash.

export interface Task {
  id: number;
  label: string;
  /** Items done / total; total null = indeterminate. */
  done: number;
  total: number | null;
  shown: boolean;
}

export const useTasks = create<{ tasks: Task[] }>(() => ({ tasks: [] }));

const SHOW_AFTER_MS = 250;
let seq = 0;

export type TaskUpdate = (patch: Partial<Pick<Task, 'label' | 'done' | 'total'>>) => void;

export async function runTask<T>(label: string, fn: (update: TaskUpdate) => Promise<T>): Promise<T> {
  const id = ++seq;
  const patch = (p: Partial<Task>) => useTasks.setState({ tasks: useTasks.getState().tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  useTasks.setState({ tasks: [...useTasks.getState().tasks, { id, label, done: 0, total: null, shown: false }] });
  const timer = setTimeout(() => patch({ shown: true }), SHOW_AFTER_MS);
  try {
    return await fn((p) => patch(p));
  } finally {
    clearTimeout(timer);
    useTasks.setState({ tasks: useTasks.getState().tasks.filter((t) => t.id !== id) });
  }
}

/** Reads files' tags in batches, reporting progress (large selections, whole folders). */
export async function probeWithProgress(paths: string[], update: TaskUpdate, label: string): Promise<Awaited<ReturnType<typeof window.chud.media.probe>>> {
  const out: Awaited<ReturnType<typeof window.chud.media.probe>> = [];
  update({ label, done: 0, total: paths.length });
  for (let i = 0; i < paths.length; i += 16) {
    out.push(...(await window.chud.media.probe(paths.slice(i, i + 16))));
    update({ done: Math.min(paths.length, i + 16) });
  }
  return out;
}
