import { create } from 'zustand';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind?: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.action ? 7000 : 4500);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().push(t);
