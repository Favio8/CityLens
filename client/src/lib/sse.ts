/** fetch 流式 SSE 解析（PRD 0.2：使用 fetch 流，不用 EventSource）。 */

export interface RawSseEvent {
  event: string;
  data: string;
}

/**
 * 逐块解析 text/event-stream。仅处理 `event:` 与 `data:` 字段，
 * 支持 `:` 注释与空行分隔；遇到 ping 交由调用方忽略。
 */
export async function consumeSse(
  response: Response,
  onEvent: (event: RawSseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error('响应不包含可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const flushBlock = (block: string): void => {
    if (!block.trim()) return;
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (eventName) onEvent({ event: eventName, data: dataLines.join('\n') });
  };

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 事件之间以空行分隔，兼容 \r\n
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        flushBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) flushBlock(buffer);
  } finally {
    reader.releaseLock();
  }
}
