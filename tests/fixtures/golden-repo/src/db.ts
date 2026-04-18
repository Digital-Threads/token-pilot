import { UserService, type User } from "./user.js";

export class Database {
  private users = new UserService();

  insert(user: User): void {
    this.users.register(user);
  }

  get(id: string): User | undefined {
    return this.users.find(id);
  }
}
