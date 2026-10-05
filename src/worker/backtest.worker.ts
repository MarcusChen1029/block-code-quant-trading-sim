import { handleRequest, type RunRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<RunRequest>) => {
  scope.postMessage(handleRequest(event.data));
};
