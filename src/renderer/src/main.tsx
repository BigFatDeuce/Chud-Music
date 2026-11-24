import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource/vt323';
// CJK interface languages (loaded per unicode range: only the glyphs on screen are fetched)
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-sans-jp';
import '@fontsource-variable/noto-sans-kr';
import { getLang } from '@shared/i18n';
import './styles/skins.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/library.css';
import './styles/youtube.css';
import './styles/visualizer.css';
import './styles/eq.css';
import './styles/responsive.css';
import './styles/lyrics.css';
import './styles/clip.css';
import './styles/radio.css';
import './styles/stats.css';
import './styles/mini.css';
import { App, boot } from './App';
import { ErrorBoundary, captureRendererErrors } from './components/ErrorBoundary';
import { toast } from './store/toasts';
import { tr } from '@shared/i18n';

document.documentElement.lang = getLang();
captureRendererErrors();

void boot().then(() => {
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
  // reloaded by the main process after the interface crashed
  if (new URLSearchParams(location.search).has('recovered')) {
    toast({ kind: 'error', title: tr('crash.recovered'), body: tr('crash.recoveredBody'), action: { label: tr('common.log'), run: () => window.chud.openLogs() } });
  }
});
