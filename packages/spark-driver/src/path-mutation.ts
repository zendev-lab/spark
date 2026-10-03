import { resolve } from "node:path";

const mutationTails = new Map<string, Promise<void>>();

export function withPathMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(key, tail);
  void tail.finally(() => {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  });
  return result;
}
