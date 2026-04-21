import type { HostToWebview, WebviewToHost } from '@agentic-whiteboard/shared';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export interface Host {
  readonly inVsCode: boolean;
  post(msg: WebviewToHost): void;
  onMessage(fn: (msg: HostToWebview) => void): () => void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
}

export function createHost(): Host {
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  let memoryState: unknown;
  return {
    inVsCode: !!api,
    post: (msg) => {
      if (api) api.postMessage(msg);
      else console.debug('[agentic-whiteboard -> host]', msg);
    },
    onMessage: (fn) => {
      const listener = (e: MessageEvent) => {
        const data = e.data as HostToWebview | undefined;
        if (data && typeof data === 'object' && 'type' in data) fn(data);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
    getState: <T>() => (api ? api.getState() : memoryState) as T | undefined,
    setState: (s) => {
      if (api) api.setState(s);
      else memoryState = s;
    },
  };
}
