import { create } from 'zustand';
import type { UpdateStatus } from '@shared/types';
import { toast } from './toasts';
import { tr } from '@shared/i18n';

// Update status from the main process (GitHub releases), plus the two moments worth a toast:
// a new version found by the automatic check, and the download finished.

export const useUpdates = create<{ status: UpdateStatus | null }>(() => ({ status: null }));

let announced: string | null = null;
let readyAnnounced = false;

function onStatus(s: UpdateStatus): void {
  const prev = useUpdates.getState().status;
  useUpdates.setState({ status: s });
  // found by a check: the first one, or a later one that finds a newer version still
  if (s.state === 'available' && s.version && announced !== s.version && (prev?.state === 'checking' || (prev?.state === 'available' && prev.version !== s.version))) {
    announced = s.version;
    toast({
      title: tr('upd.toastAvailable', { v: s.version }),
      body: s.inApp ? tr('upd.toastInApp') : tr('upd.toastGithub'),
      action: { label: s.inApp ? tr('upd.update') : tr('upd.seeGithub'), run: () => void window.chud.updates.download() },
    });
  }
  if (s.state === 'downloaded' && !readyAnnounced) {
    readyAnnounced = true;
    toast({
      title: tr('upd.toastReady', { v: s.version }),
      body: tr('upd.toastReadyBody'),
      action: { label: tr('upd.restart'), run: () => window.chud.updates.install() },
    });
  }
}

void window.chud.updates.status().then((s) => useUpdates.setState({ status: s }));
window.chud.updates.onStatus(onStatus);
