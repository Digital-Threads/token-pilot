import { describe, it, expect } from 'vitest';
import { parseTypeScriptRegex } from '../../src/ast-index/regex-parser.js';

describe('parseTypeScriptRegex', () => {
  it('returns empty array for empty content', () => {
    expect(parseTypeScriptRegex('')).toEqual([]);
  });

  it('parses top-level function declarations', () => {
    const content = [
      'export function greet(name: string): string {',
      '  return `Hello ${name}`;',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('greet');
    expect(entries[0].kind).toBe('function');
    expect(entries[0].start_line).toBe(1);
  });

  it('parses async functions', () => {
    const content = 'export async function fetchData(): Promise<void> {}';
    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('fetchData');
    expect(entries[0].kind).toBe('function');
  });

  it('parses arrow function assignments', () => {
    const content = 'export const handler = async (req: Request) => {};';
    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('handler');
    expect(entries[0].kind).toBe('function');
  });

  it('parses class declarations with methods', () => {
    const content = [
      'export class UserService {',
      '  constructor(private db: DB) {}',
      '  async findById(id: string) {',
      '    return this.db.find(id);',
      '  }',
      '  private formatUser(user: User) {',
      '    return user;',
      '  }',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('UserService');
    expect(entries[0].kind).toBe('class');
    expect(entries[0].children).toBeDefined();
    const methods = entries[0].children!.map(c => c.name);
    expect(methods).toContain('findById');
    expect(methods).toContain('formatUser');
  });

  it('parses interface declarations', () => {
    const content = [
      'export interface Config {',
      '  timeout: number;',
      '  retries: number;',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('Config');
    expect(entries[0].kind).toBe('interface');
  });

  it('parses type aliases', () => {
    const content = 'export type Handler = (req: Request) => Response;';
    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('Handler');
    expect(entries[0].kind).toBe('type');
  });

  it('parses enum declarations', () => {
    const content = [
      'export enum Status {',
      '  Active,',
      '  Inactive,',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('Status');
    expect(entries[0].kind).toBe('enum');
  });

  it('parses multiple top-level symbols with correct line numbers', () => {
    const content = [
      'export interface Foo {}',
      '',
      'export class Bar {',
      '  run() {}',
      '}',
      '',
      'export function baz() {}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe('Foo');
    expect(entries[0].start_line).toBe(1);
    expect(entries[1].name).toBe('Bar');
    expect(entries[1].start_line).toBe(3);
    expect(entries[2].name).toBe('baz');
    expect(entries[2].start_line).toBe(7);
  });

  it('does not include reserved words as symbol names', () => {
    const content = [
      'if (condition) {',
      '  const x = 1;',
      '}',
    ].join('\n');
    expect(parseTypeScriptRegex(content)).toHaveLength(0);
  });

  it('does not include method calls as class methods', () => {
    const content = [
      'export class Service {',
      '  async process() {',
      '    this.helper();',
      '    console.log("done");',
      '  }',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    const methods = entries[0].children!.map(c => c.name);
    expect(methods).toContain('process');
    expect(methods).not.toContain('helper');
    expect(methods).not.toContain('log');
  });

  it('assigns end_line to top-level entries', () => {
    const content = [
      'export function foo() {',
      '  return 1;',
      '}',
      'export function bar() {',
      '  return 2;',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    expect(entries[0].end_line).toBeGreaterThan(entries[0].start_line);
    expect(entries[1].end_line).toBeGreaterThan(entries[1].start_line);
  });

  it('parses abstract class', () => {
    const content = 'export abstract class BaseService {}';
    const entries = parseTypeScriptRegex(content);
    expect(entries[0].name).toBe('BaseService');
    expect(entries[0].kind).toBe('class');
  });

  it('parses class with static and visibility modifiers on methods', () => {
    const content = [
      'class Auth {',
      '  public static getInstance() {}',
      '  private validateToken(token: string) {}',
      '}',
    ].join('\n');

    const entries = parseTypeScriptRegex(content);
    const methods = entries[0].children!.map(c => c.name);
    expect(methods).toContain('getInstance');
    expect(methods).toContain('validateToken');
  });
});
