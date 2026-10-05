import { AsyncLocalStorage } from "node:async_hooks";

/* Request-scoped identity for the agent pipeline.

   The agents call agentChat(plan, agent, …) without knowing who they are
   working for, and threading userId through six agents would touch every call
   site. AsyncLocalStorage carries it instead: the job kickers open a scope
   with the run's owner, and resolveChain reads it back anywhere down the async
   tree — including inside the fire-and-forget jobs.

   Empty userId (an admin-triggered run) resolves to the platform chain. */

export type UserScope = { userId: string | null };

const storage = new AsyncLocalStorage<UserScope>();

export function runAsUser<T>(userId: string | null, fn: () => T): T {
  return storage.run({ userId }, fn);
}

export function currentUserScope(): UserScope {
  return storage.getStore() ?? { userId: null };
}

export function currentUserId(): string | null {
  return currentUserScope().userId;
}
