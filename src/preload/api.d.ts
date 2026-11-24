import type { ChudApi } from '../shared/types';

declare global {
  interface Window {
    chud: ChudApi;
  }
}

export {};
