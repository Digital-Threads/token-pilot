import { describe, it, expect } from 'vitest';
import { parsePythonRegex } from '../../src/ast-index/regex-parser-python.js';

describe('parsePythonRegex', () => {
  it('returns empty array for empty content', () => {
    expect(parsePythonRegex('')).toEqual([]);
  });

  it('parses top-level function', () => {
    const content = [
      'def greet(name: str) -> str:',
      '    return f"Hello {name}"',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('greet');
    expect(entries[0].kind).toBe('function');
    expect(entries[0].start_line).toBe(1);
  });

  it('parses async function', () => {
    const content = 'async def fetch_data(url: str) -> dict:';
    const entries = parsePythonRegex(content);
    expect(entries[0].name).toBe('fetch_data');
    expect(entries[0].kind).toBe('function');
    expect(entries[0].is_async).toBe(true);
  });

  it('parses class with methods', () => {
    const content = [
      'class UserService:',
      '    def __init__(self, db):',
      '        self.db = db',
      '',
      '    async def find_by_id(self, id: str):',
      '        return self.db.find(id)',
      '',
      '    def _format_user(self, user):',
      '        return user',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('UserService');
    expect(entries[0].kind).toBe('class');
    expect(entries[0].children).toBeDefined();
    const methods = entries[0].children!.map(c => c.name);
    expect(methods).toContain('__init__');
    expect(methods).toContain('find_by_id');
    expect(methods).toContain('_format_user');
  });

  it('detects method visibility', () => {
    const content = [
      'class Foo:',
      '    def public_method(self):',
      '        pass',
      '    def _private_method(self):',
      '        pass',
      '    def __dunder__(self):',
      '        pass',
    ].join('\n');

    const entries = parsePythonRegex(content);
    const methods = entries[0].children!;
    expect(methods.find(m => m.name === 'public_method')?.visibility).toBe('public');
    expect(methods.find(m => m.name === '_private_method')?.visibility).toBe('private');
    expect(methods.find(m => m.name === '__dunder__')?.visibility).toBe('public');
  });

  it('parses decorated functions', () => {
    const content = [
      '@app.route("/api")',
      '@login_required',
      'def api_handler():',
      '    pass',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries[0].name).toBe('api_handler');
    expect(entries[0].decorators).toEqual(['@app.route', '@login_required']);
  });

  it('parses module-level constants', () => {
    const content = [
      'MAX_RETRIES = 3',
      'DEFAULT_TIMEOUT = 30',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('MAX_RETRIES');
    expect(entries[0].kind).toBe('variable');
    expect(entries[1].name).toBe('DEFAULT_TIMEOUT');
  });

  it('parses multiple top-level symbols', () => {
    const content = [
      'class Foo:',
      '    pass',
      '',
      'class Bar:',
      '    def run(self):',
      '        pass',
      '',
      'def baz():',
      '    pass',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe('Foo');
    expect(entries[1].name).toBe('Bar');
    expect(entries[2].name).toBe('baz');
  });

  it('does not include reserved words', () => {
    const content = [
      'if condition:',
      '    x = 1',
    ].join('\n');
    expect(parsePythonRegex(content)).toHaveLength(0);
  });

  it('assigns end_line to entries', () => {
    const content = [
      'def foo():',
      '    return 1',
      '',
      'def bar():',
      '    return 2',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries[0].end_line).toBeGreaterThan(entries[0].start_line);
    expect(entries[1].end_line).toBeGreaterThanOrEqual(entries[1].start_line);
  });

  it('parses class with inheritance', () => {
    const content = 'class Admin(User, PermissionMixin):';
    const entries = parsePythonRegex(content);
    expect(entries[0].name).toBe('Admin');
    expect(entries[0].kind).toBe('class');
  });

  it('parses decorated class', () => {
    const content = [
      '@dataclass',
      'class Config:',
      '    timeout: int = 30',
    ].join('\n');

    const entries = parsePythonRegex(content);
    expect(entries[0].name).toBe('Config');
    expect(entries[0].decorators).toEqual(['@dataclass']);
  });

  it('parses async methods in class', () => {
    const content = [
      'class Service:',
      '    async def process(self):',
      '        pass',
    ].join('\n');

    const entries = parsePythonRegex(content);
    const method = entries[0].children![0];
    expect(method.name).toBe('process');
    expect(method.is_async).toBe(true);
  });
});
