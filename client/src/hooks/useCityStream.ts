/**
 * 城市档案流式读取 Hook（PRD 2.2 状态机 / 3.4 SSE 协议）。
 * - 先读缓存；未生成则自动发起 fetch 流式生成；
 * - 切换城市或卸载时只取消前端订阅（AbortController），服务端任务继续完成并落库；
 * - 流中断时有界自动重连（复用服务端单飞任务与事件回放），重连耗尽给出明确重试入口。
 *
 * 状态机本体在 lib/cityStream.ts（框架无关、可单测）；本 Hook 只负责接线。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModuleName } from '@citylens/shared/schema';
import { getCityArchive } from '../lib/api';
import { consumeSse } from '../lib/sse';
import {
  CityStreamController,
  archiveToModules,
  initialStreamState,
  type CityStreamState,
  type GenerateOptions,
  type StreamPhase,
  type StreamedModule,
} from '../lib/cityStream';

export { archiveToModules };
export type { CityStreamState, StreamPhase, StreamedModule };

export function useCityStream(cityId: string) {
  const [state, setState] = useState<CityStreamState>(initialStreamState);
  const controllerRef = useRef<CityStreamController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new CityStreamController({
      fetchArchive: (id, signal) => getCityArchive(id, signal),
      fetchStream: (id, options, signal) =>
        fetch(`/api/cities/${encodeURIComponent(id)}/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(options.adminToken ? { 'x-admin-token': options.adminToken } : {}),
          },
          body: JSON.stringify({
            force: options.force ?? false,
            ...(options.modules ? { modules: options.modules } : {}),
          }),
          signal,
        }),
      consume: (response, onEvent, signal) =>
        consumeSse(response, onEvent, signal),
      onChange: setState,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current!;
    controller.openCity(cityId);
    return () => controller.close();
  }, [cityId]);

  const startGeneration = useCallback((options: GenerateOptions = {}) => {
    void controllerRef.current?.startGeneration(options);
  }, []);

  const retryModule = useCallback((name: ModuleName) => {
    controllerRef.current?.retryModule(name);
  }, []);

  const regenerate = useCallback((adminToken?: string) => {
    controllerRef.current?.regenerate(adminToken);
  }, []);

  return { state, startGeneration, retryModule, regenerate };
}
