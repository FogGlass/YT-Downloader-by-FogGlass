/** A tiny typed event bus for cross-component signals (shortcuts → composer). */

type Handler<T> = (payload: T) => void;

const channels = new Map<string, Set<Handler<unknown>>>();

export function emit<T>(channel: string, payload?: T): void {
  const handlers = channels.get(channel);
  if (!handlers) {
    return;
  }
  for (const handler of handlers) {
    handler(payload as unknown);
  }
}

export function on<T>(channel: string, handler: Handler<T>): () => void {
  const handlers = channels.get(channel) ?? new Set();
  handlers.add(handler as Handler<unknown>);
  channels.set(channel, handlers);
  return () => {
    handlers.delete(handler as Handler<unknown>);
  };
}

/** Channel names used by the shell. */
export const bus = {
  focusUrl: "composer:focus",
  submit: "composer:submit",
  clear: "composer:clear",
  paste: "composer:paste",
} as const;
