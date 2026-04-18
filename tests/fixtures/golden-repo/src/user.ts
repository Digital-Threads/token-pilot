export interface User {
  id: string;
  email: string;
  name: string;
}

export class UserService {
  private byId = new Map<string, User>();

  register(user: User): void {
    if (this.byId.has(user.id)) {
      throw new Error(`user ${user.id} already registered`);
    }
    this.byId.set(user.id, user);
  }

  find(id: string): User | undefined {
    return this.byId.get(id);
  }

  rename(id: string, name: string): User {
    const u = this.byId.get(id);
    if (!u) throw new Error(`unknown user ${id}`);
    const next = { ...u, name };
    this.byId.set(id, next);
    return next;
  }
}
