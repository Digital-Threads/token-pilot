import { describe, it, expect } from 'vitest';
import { classifyIntent, ALL_INTENTS } from '../../src/core/intent-classifier.js';

describe('classifyIntent', () => {
  it('classifies edit tools', () => {
    expect(classifyIntent('read_for_edit')).toBe('edit');
  });

  it('classifies review tools', () => {
    expect(classifyIntent('smart_diff')).toBe('review');
    expect(classifyIntent('smart_log')).toBe('review');
    expect(classifyIntent('read_diff')).toBe('review');
  });

  it('classifies explore tools', () => {
    expect(classifyIntent('project_overview')).toBe('explore');
    expect(classifyIntent('explore_area')).toBe('explore');
    expect(classifyIntent('outline')).toBe('explore');
  });

  it('classifies search tools', () => {
    expect(classifyIntent('find_usages')).toBe('search');
    expect(classifyIntent('related_files')).toBe('search');
  });

  it('classifies analyze tools', () => {
    expect(classifyIntent('code_audit')).toBe('analyze');
    expect(classifyIntent('find_unused')).toBe('analyze');
    expect(classifyIntent('module_info')).toBe('analyze');
  });

  it('classifies debug tools', () => {
    expect(classifyIntent('test_summary')).toBe('debug');
  });

  it('classifies read tools', () => {
    expect(classifyIntent('smart_read')).toBe('read');
    expect(classifyIntent('read_symbol')).toBe('read');
    expect(classifyIntent('read_range')).toBe('read');
    expect(classifyIntent('smart_read_many')).toBe('read');
  });

  it('defaults to read for unknown tools', () => {
    expect(classifyIntent('unknown_tool')).toBe('read');
  });

  it('exports ALL_INTENTS with all categories', () => {
    expect(ALL_INTENTS).toContain('edit');
    expect(ALL_INTENTS).toContain('debug');
    expect(ALL_INTENTS).toContain('explore');
    expect(ALL_INTENTS).toContain('review');
    expect(ALL_INTENTS).toContain('analyze');
    expect(ALL_INTENTS).toContain('search');
    expect(ALL_INTENTS).toContain('read');
    expect(ALL_INTENTS.length).toBe(7);
  });
});
