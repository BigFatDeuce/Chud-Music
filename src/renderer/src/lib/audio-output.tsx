import { Check, Speaker } from 'lucide-react';
import { showMenu, type MenuItem } from '@/components/ContextMenu';
import { useSettings } from '@/store/settings';
import { toast } from '@/store/toasts';
import { applyOutput } from '@/store/player';
import { tr } from '@shared/i18n';

export interface OutputDevice {
  id: string;
  label: string;
}

/** Audio outputs known to the system ("default" first). */
export async function listOutputs(): Promise<OutputDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return [{ id: 'default', label: tr('out.default') }, ...outs.map((d, i) => ({ id: d.deviceId, label: d.label || tr('out.nth', { n: i + 1 }) }))];
}

export async function chooseOutput(id: string, label: string | null = null): Promise<void> {
  useSettings.getState().set({ outputDevice: id, outputLabel: id === 'default' ? null : label });
  const r = await applyOutput(id);
  if (!r.local) toast({ kind: 'error', title: tr('out.unavailable'), body: tr('out.refused') });
}

/** Right-click on the volume icon: pick the output device. */
export async function outputMenu(e: React.MouseEvent): Promise<void> {
  e.preventDefault();
  const at = { clientX: e.clientX, clientY: e.clientY, preventDefault() {} };
  const current = useSettings.getState().outputDevice;
  const items: MenuItem[] = (await listOutputs()).map((d) => ({
    label: d.label,
    icon: d.id === current ? <Check size={15} /> : <Speaker size={15} />,
    onSelect: () => void chooseOutput(d.id, d.label),
  }));
  showMenu(at, items);
}
