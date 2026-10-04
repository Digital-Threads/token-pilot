export const UPPER = 1;
export const lowerConst = 2;
export let lowerLet = { a: 1 };
const notExported = 3;

export class Svc {
  constructor(
    private readonly a: string,
    private readonly b: number,
  ) {}

  static make(): Svc {
    return new Svc('x', 1);
  }

  handler = () => {
    return this.a;
  };

  field: number = 1
}

export enum Color {
  Red,
  Green,
}

export abstract class Base {
  abstract run(): void;
  protected helper(): void {}
}

declare module 'x' {
  export function y(): void;
}

namespace NS {
  export function z() {}
}

export function* gen() {
  yield 1;
}

export async function asyncFn(): Promise<{ a: number }> {
  return { a: 1 };
}

const re = /[{]/;
const notRe = 4 / 2 / 1;
void notExported; void re; void notRe;

export function afterRegex() {
  return re.source.length > 0 ? { ok: true } : { ok: false };
}
