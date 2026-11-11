/**
 * 错误边界（P1-17）：单卷 / 单路由异常只降级对应区域，不白屏。
 * class 组件：捕获渲染期错误，打印到控制台，展示降级卡片与重试按钮。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 降级时展示的标题，如「此卷渲染异常」。 */
  title?: string;
  /** 重置用的 key 变化时自动重试（如城市切换）。 */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-md border border-dashed p-8 text-center hairline" role="alert">
        <p className="font-serif text-base tracking-[0.08em]">{this.props.title ?? '内容渲染异常'}</p>
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          该区域已安全降级，其余内容不受影响。可重试；若持续失败，将进入人工复核清单。
        </p>
        <button type="button" className="ink-btn mt-4 px-4 py-2 text-[11px]" onClick={this.retry}>
          重试
        </button>
      </div>
    );
  }
}
