import { displayName, type User } from "./model.js";

export function greeting(user: User): string {
  return `Hello, ${displayName(user)}`;
}
