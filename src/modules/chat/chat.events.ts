/**
 * The service publishes real-time events through this one function; chat.realtime.ts plugs in the
 * Socket.IO implementation at startup. Without it (tests, scripts) events are simply dropped -
 * clients always recover from the database, so an event is a hint, never the source of truth.
 */
type Emit = (userIds: string[], event: string, payload: unknown) => void;

let emitter: Emit = () => undefined;

export const setChatEmitter = (fn: Emit): void => {
  emitter = fn;
};

export const emitToUsers = (userIds: Array<{ toString(): string }>, event: string, payload: unknown): void => {
  if (userIds.length) emitter([...new Set(userIds.map(String))], event, payload);
};
