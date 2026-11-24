import { useEffect, useState } from 'react';
import { Copy, Maximize2, Menu, Minus, PictureInPicture2, Pin, PinOff, Square, X } from 'lucide-react';
import { useLayout } from '@/store/layout';
import logoSmall from '@/assets/logo.svg';
import { tr } from '@shared/i18n';

export function Titlebar() {
  const [maximized, setMaximized] = useState(false);
  const [version, setVersion] = useState('');
  const { compact, drawer, setDrawer, mini, setMini, onTop, setOnTop } = useLayout();
  useEffect(() => window.chud.window.onMaximizedChange(setMaximized), []);
  useEffect(() => void window.chud.appInfo().then((i) => setVersion(i.version)), []);

  return (
    <header className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && window.chud.window.toggleMaximize()}>
      {compact && (
        <button className="icon-btn menu-btn" aria-label={drawer ? tr('title.closeMenu') : tr('title.menu')} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
          {drawer ? <X size={18} /> : <Menu size={18} />}
        </button>
      )}
      <div className="brand">
        <img className="brand-mark" src={logoSmall} alt="" draggable={false} />
        Chud Music
        {version && <small>{version}</small>}
      </div>
      <div className="titlebar-spacer" />
      {mini ? (
        <div className="mini-controls">
          <button className={`icon-btn mini-pin${onTop ? ' on' : ''}`} aria-pressed={onTop} aria-label={tr('mini.onTop')} title={tr('mini.onTop')} onClick={() => setOnTop(!onTop)}>
            {onTop ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button className="btn primary mini-expand" onClick={() => setMini(false)} title={tr('mini.backHint')}>
            <Maximize2 size={14} /> {tr('mini.expand')}
          </button>
        </div>
      ) : (
        <button className="icon-btn mini-open" aria-label={tr('mini.title')} title={tr('mini.hint')} onClick={() => setMini(true)}>
          <PictureInPicture2 size={16} />
        </button>
      )}
      <div className="win-controls">
        <button aria-label={tr('win.minimize')} onClick={() => window.chud.window.minimize()}>
          <Minus size={16} />
        </button>
        <button aria-label={maximized ? tr('win.restore') : tr('win.maximize')} hidden={mini} onClick={() => window.chud.window.toggleMaximize()}>
          {maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} />}
        </button>
        <button className="close" aria-label={tr('common.close')} onClick={() => window.chud.window.close()}>
          <X size={17} />
        </button>
      </div>
    </header>
  );
}
