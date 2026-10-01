import React from 'react';
import { TriangleAlert, RotateCcw } from 'lucide-react';
import { I18nCtx } from '../i18n';

// Keeps a single broken screen from taking down the whole app with a white screen.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static contextType = I18nCtx;

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('UI error:', error, info && info.componentStack);
  }

  // The boundary is also used outside an I18nProvider, for example on /platform,
  // so it falls back to plain English rather than crashing while reporting a crash.
  t(key) {
    return this.context && this.context.t ? this.context.t(key) : key;
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <div className="crash-icon"><TriangleAlert size={22} /></div>
          <h2>{this.t('Something went wrong')}</h2>
          <p className="muted">{this.t('This screen ran into an error. Your data is safe.')}</p>
          <pre className="crash-detail">{String(this.state.error && this.state.error.message)}</pre>
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>{this.t('Try again')}</button>
            <button className="btn primary" onClick={() => window.location.reload()}><RotateCcw size={15} /> {this.t('Reload')}</button>
          </div>
        </div>
      </div>
    );
  }
}