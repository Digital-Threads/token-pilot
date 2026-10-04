import { readFile } from 'node:fs/promises';

/** Doc for Alpha */
@Component({ a: 1 })
export class Alpha {
  private n = 1;

  /** run doc */
  run(): void {
    const s = `a ${ { b: 1 }.b } }`;
    const r = /}/g;
    // }
    void s; void r;
  }

  get value(): number { return 1; }
}

export function outer(a: string): void {
  function inner() {
    return '}';
  }
  const arrow = () => {
    return 1;
  };
  void a; void inner; void arrow;
}

export function over(a: string): string;
export function over(a: number): number;
export function over(a: any): any {
  return a;
}

export const foo = (x: number) => {
  return x * 2;
};

export const cfg = { a: 1 };

export type T = { a: string };

interface I {
  a: string;
}

export default {};

export const lower = 1;

function Component(_o: object) { return (_t: unknown) => undefined; }
void readFile;
