import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort boundary: a rendering exception must not leave the user with a
 * blank window and no way to recover.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ChessMind render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash-screen">
        <h1>界面出现错误</h1>
        <p className="crash-message">{this.state.error.message}</p>
        <div className="crash-actions">
          <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
            重新载入
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => this.setState({ error: null })}
          >
            返回
          </button>
        </div>
        <p className="crash-hint">
          你的设置保存在本机，重新载入不会丢失。如果问题持续出现，请附上下方信息反馈。
        </p>
        <pre className="crash-stack">{this.state.error.stack}</pre>
      </div>
    );
  }
}
