import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProject, detectQualityTools, detectCI, detectDocker } from '../../src/core/project-detector.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tp-detect-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('detectProject', () => {
  it('detects Node.js project from package.json', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.2.3',
      description: 'Test app',
      dependencies: { '@nestjs/core': '^10.0.0' },
      engines: { node: '>=18.0.0' },
    }));

    const result = await detectProject(tempDir);
    expect(result.projectName).toBe('my-app');
    expect(result.projectVersion).toBe('1.2.3');
    expect(result.configStacks).toHaveLength(1);
    expect(result.configStacks[0].type).toBe('Node.js/TypeScript');
    expect(result.configStacks[0].framework).toBe('NestJS 10');
    expect(result.configStacks[0].langVersion).toBe('Node 18.0.0+');
  });

  it('detects PHP project from composer.json', async () => {
    await writeFile(join(tempDir, 'composer.json'), JSON.stringify({
      name: 'vendor/laravel-app',
      require: { php: '>=8.2', 'laravel/framework': '^11.0' },
    }));

    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(1);
    expect(result.configStacks[0].type).toBe('PHP');
    expect(result.configStacks[0].framework).toBe('Laravel 11');
    expect(result.configStacks[0].langVersion).toBe('PHP 8.2+');
  });

  it('detects multi-stack project (PHP + Node.js)', async () => {
    await writeFile(join(tempDir, 'composer.json'), JSON.stringify({
      name: 'vendor/app',
      require: { php: '>=8.2' },
    }));
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({
      name: 'frontend',
      dependencies: { vue: '^3.0' },
    }));

    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(2);
    expect(result.primaryStack?.type).toBe('PHP');
    expect(result.confidence).toBe('medium');
  });

  it('detects Rust project from Cargo.toml', async () => {
    await writeFile(join(tempDir, 'Cargo.toml'), `
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"
`);

    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(1);
    expect(result.configStacks[0].type).toBe('Rust');
    expect(result.configStacks[0].name).toBe('my-crate');
  });

  it('detects Python project from pyproject.toml', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), `
[project]
name = "my-api"
version = "2.0.0"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.100"]
`);

    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(1);
    expect(result.configStacks[0].type).toBe('Python');
    expect(result.configStacks[0].framework).toBe('FastAPI');
    expect(result.configStacks[0].langVersion).toBe('Python 3.11+');
  });

  it('detects Go project from go.mod', async () => {
    await writeFile(join(tempDir, 'go.mod'), `module github.com/user/myapp

go 1.22
`);

    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(1);
    expect(result.configStacks[0].type).toBe('Go');
    expect(result.configStacks[0].langVersion).toBe('Go 1.22');
  });

  it('returns unknown for empty project', async () => {
    const result = await detectProject(tempDir);
    expect(result.configStacks).toHaveLength(0);
    expect(result.confidence).toBe('unknown');
    expect(result.projectName).toBe(tempDir.split('/').pop());
  });

  it('sets high confidence when ast-index agrees with single config', async () => {
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    const result = await detectProject(tempDir, 'TypeScript');
    expect(result.confidence).toBe('high');
  });

  it('sets low confidence when ast-index disagrees with config', async () => {
    await writeFile(join(tempDir, 'composer.json'), JSON.stringify({ name: 'php-app', require: { php: '>=8.0' } }));
    const result = await detectProject(tempDir, 'Rust');
    expect(result.confidence).toBe('low');
  });
});

describe('detectQualityTools', () => {
  it('detects ESLint config', async () => {
    await writeFile(join(tempDir, 'eslint.config.js'), 'export default {};');
    const tools = await detectQualityTools(tempDir);
    expect(tools).toContain('ESLint');
  });

  it('detects TypeScript', async () => {
    await writeFile(join(tempDir, 'tsconfig.json'), '{}');
    const tools = await detectQualityTools(tempDir);
    expect(tools).toContain('TypeScript');
  });

  it('detects Ruff from ruff.toml', async () => {
    await writeFile(join(tempDir, 'ruff.toml'), '[lint]\nselect = ["E"]');
    const tools = await detectQualityTools(tempDir);
    expect(tools).toContain('Ruff');
  });

  it('detects Ruff from pyproject.toml [tool.ruff]', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.ruff]\nselect = ["E"]');
    const tools = await detectQualityTools(tempDir);
    expect(tools).toContain('Ruff');
  });

  it('does NOT detect Ruff from pyproject.toml without [tool.ruff]', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), '[project]\nname = "x"\nversion = "1.0"');
    const tools = await detectQualityTools(tempDir);
    expect(tools).not.toContain('Ruff');
  });

  it('returns empty for clean directory', async () => {
    const tools = await detectQualityTools(tempDir);
    expect(tools).toHaveLength(0);
  });
});

describe('detectCI', () => {
  it('detects GitHub Actions', async () => {
    await mkdir(join(tempDir, '.github', 'workflows'), { recursive: true });
    await writeFile(join(tempDir, '.github', 'workflows', 'ci.yml'), 'name: CI');
    const pipelines = await detectCI(tempDir);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toMatch(/GitHub Actions/);
  });

  it('detects GitLab CI', async () => {
    await writeFile(join(tempDir, '.gitlab-ci.yml'), 'stages: [build]');
    const pipelines = await detectCI(tempDir);
    expect(pipelines).toContain('GitLab CI');
  });

  it('returns empty for no CI', async () => {
    const pipelines = await detectCI(tempDir);
    expect(pipelines).toHaveLength(0);
  });
});

describe('detectDocker', () => {
  it('detects Dockerfile', async () => {
    await writeFile(join(tempDir, 'Dockerfile'), 'FROM node:18');
    expect(await detectDocker(tempDir)).toBe(true);
  });

  it('detects docker-compose.yml', async () => {
    await writeFile(join(tempDir, 'docker-compose.yml'), 'version: "3"');
    expect(await detectDocker(tempDir)).toBe(true);
  });

  it('returns false when no Docker files', async () => {
    expect(await detectDocker(tempDir)).toBe(false);
  });
});
