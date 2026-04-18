import { Database } from "./db.js";
import type { User } from "./user.js";

const db = new Database();

export function createUser(user: User): void {
  db.insert(user);
}

export function getUser(id: string): User {
  const u = db.get(id);
  if (!u) throw new Error(`not found: ${id}`);
  return u;
}
