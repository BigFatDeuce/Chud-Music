import { Component, type ReactNode } from 'react';
import { tr } from '@shared/i18n';

// A rendering bug must not leave an empty window: show what happened and a way out. Playback
// and data live outside the interface, so reloading it loses nothing.

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    window.chud.logError(`render error: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h1>{tr('crash.title')}</h1>
        <p>{tr('crash.body')}</p>
        <code>{this.state.error.message}</code>
        <div className="fatal-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            {tr('crash.reload')}
          </button>
          <button className="btn" onClick={() => window.chud.openLogs()}>
            {tr('crash.openLog')}
          </button>
        </div>
      </div>
    );
  }
}

/**
 * Around one page: a bug in a page leaves the rest of the window working (sidebar, tabs, player,
 * playback). "Try again" draws the page anew; switching tab does too (a new key).
 */
export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    window.chud.logError(`page render error: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal page-fatal" role="alert">
        <h1>{tr('crash.title')}</h1>
        <p>{tr('crash.body')}</p>
        <code>{this.state.error.message}</code>
        <div className="fatal-actions">
          <button className="btn primary" onClick={() => this.setState({ error: null })}>
            {tr('common.retry')}
          </button>
          <button className="btn" onClick={() => location.reload()}>
            {tr('crash.reload')}
          </button>
          <button className="btn" onClick={() => window.chud.openLogs()}>
            {tr('crash.openLog')}
          </button>
        </div>
      </div>
    );
  }
}

/** Errors outside React rendering (event handlers, promises) go to the log file too. */
export function captureRendererErrors(): void {
  window.addEventListener('error', (e) => window.chud.logError(`${e.message} (${e.filename}:${e.lineno})${e.error?.stack ? `\n${e.error.stack}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => window.chud.logError(`unhandled rejection: ${e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)}`));
}
