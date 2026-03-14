import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../src/ast-index/binary-manager.js';

describe('isNewerVersion', () => {
  it('detects newer major version', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
  });

  it('detects newer minor version', () => {
    expect(isNewerVersion('1.2.0', '1.3.0')).toBe(true);
  });

  it('detects newer patch version', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false);
  });

  it('handles v prefix', () => {
    expect(isNewerVersion('v1.0.0', 'v2.0.0')).toBe(true);
    expect(isNewerVersion('v1.0.0', '1.0.0')).toBe(false);
  });

  it('handles different segment lengths', () => {
    expect(isNewerVersion('1.0', '1.0.1')).toBe(true);
    expect(isNewerVersion('1.0.1', '1.0')).toBe(false);
  });

  it('handles large version numbers', () => {
    expect(isNewerVersion('3.24.0', '3.25.0')).toBe(true);
    expect(isNewerVersion('3.25.0', '3.24.0')).toBe(false);
  });

  it('handles real-world ast-index versions', () => {
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(false);
  });
});
