// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('正常渲染 children', () => {
    const html = renderToString(
      <ErrorBoundary title="此卷渲染异常">
        <p>卷一正文</p>
      </ErrorBoundary>,
    );
    expect(html).toContain('卷一正文');
    expect(html).not.toContain('此卷渲染异常');
  });

  it('getDerivedStateFromError 进入降级状态', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error('x'));
    expect(state.error).toBeInstanceOf(Error);
  });

  it('降级渲染包含标题、说明与重试按钮', () => {
    const boundary = new ErrorBoundary({ title: '此卷渲染异常', children: null });
    boundary.state = { error: new Error('x') };
    const html = renderToString(boundary.render());
    expect(html).toContain('此卷渲染异常');
    expect(html).toContain('已安全降级');
    expect(html).toContain('重试');
  });

  it('retry 请求清除错误状态', () => {
    const boundary = new ErrorBoundary({ children: <p>ok</p> });
    boundary.state = { error: new Error('x') };
    const spy = vi.spyOn(boundary, 'setState');
    (boundary as unknown as { retry: () => void }).retry();
    expect(spy).toHaveBeenCalledWith({ error: null });
  });

  it('resetKey 变化时请求清除错误状态，不变则不清除', () => {
    const boundary = new ErrorBoundary({ children: <p>ok</p>, resetKey: 'a' });
    boundary.state = { error: new Error('x') };
    const spy = vi.spyOn(boundary, 'setState');
    boundary.componentDidUpdate({ children: null, resetKey: 'a' });
    expect(spy).not.toHaveBeenCalled();
    boundary.componentDidUpdate({ children: null, resetKey: 'b' });
    expect(spy).toHaveBeenCalledWith({ error: null });
  });

  it('renderToString 遇到子组件抛错时由 React 抛出（边界在客户端生效）', () => {
    // 说明：renderToString 不触发 componentDidCatch；此处仅固定 class 边界契约。
    expect(() => renderToString(<Boom />)).toThrow('boom');
  });
});
