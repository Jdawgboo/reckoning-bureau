export function bindRequestsToReadyContext<TContext, TRequest, TResponse>(
  register: (handler: (request: TRequest) => Promise<TResponse>) => void,
  contextReady: Promise<TContext>,
  handle: (context: TContext, request: TRequest) => TResponse | Promise<TResponse>,
): Promise<TContext> {
  register(async (request) => handle(await contextReady, request));
  return contextReady;
}
