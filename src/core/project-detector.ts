import { readFile, readdir, access, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface DetectedStack {
  type: string;           // 'PHP', 'Node.js/TypeScript', 'Rust', 'Python', 'Go'
  name: string;
  version: string;
  langVersion?: string;   // 'PHP 8.4+', 'Node 18+'
  framework?: string;     // 'Laravel 12', 'Next.js 15'
  description?: string;
}

export interface ProjectDetection {
  /** Project name (from primary config or dirname) */
  projectName: string;
  /** Project version (from primary config) */
  projectVersion: string;
  /** Project description */
  projectDescription?: string;
  /** What ast-index map() says about project type */
  astIndexType?: string;
  /** All detected stacks from config files */
  configStacks: DetectedStack[];
  /** Primary stack (most source files) */
  primaryStack?: DetectedStack;
  /** Confidence of detection */
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  /** Quality tools found */
  qualityTools: string[];
  /** CI pipelines found */
  ciPipelines: string[];
  /** Docker presence */
  hasDocker: boolean;
}

// ──────────────────────────────────────────────
// Framework detection maps
// ──────────────────────────────────────────────

const PHP_FRAMEWORKS: Record<string, string> = {
  'laravel/framework': 'Laravel',
  'symfony/framework-bundle': 'Symfony',
  'symfony/symfony': 'Symfony',
  'yiisoft/yii2': 'Yii 2',
  'cakephp/cakephp': 'CakePHP',
  'slim/slim': 'Slim',
  'codeigniter4/framework': 'CodeIgniter',
};

const JS_FRAMEWORKS: Record<string, string> = {
  'next': 'Next.js',
  'react': 'React',
  'vue': 'Vue',
  '@angular/core': 'Angular',
  'svelte': 'Svelte',
  '@nestjs/core': 'NestJS',
  'express': 'Express',
  'fastify': 'Fastify',
  'nuxt': 'Nuxt',
  '@remix-run/node': 'Remix',
};

const PYTHON_FRAMEWORKS: Record<string, string> = {
  'django': 'Django',
  'flask': 'Flask',
  'fastapi': 'FastAPI',
  'tornado': 'Tornado',
  'starlette': 'Starlette',
};

// ──────────────────────────────────────────────
// Main detection
// ──────────────────────────────────────────────

/**
 * Detect project stacks by reading all config files in parallel.
 * Returns dual-detection data: ast-index type + config-based stacks.
 */
export async function detectProject(
  projectRoot: string,
  astIndexType?: string,
): Promise<ProjectDetection> {
  // Read all configs in parallel
  const [pkgResult, composerResult, cargoResult, pyResult, goResult] = await Promise.allSettled([
    readJSON<PackageJson>(resolve(projectRoot, 'package.json')),
    readJSON<ComposerJson>(resolve(projectRoot, 'composer.json')),
    readText(resolve(projectRoot, 'Cargo.toml')),
    readText(resolve(projectRoot, 'pyproject.toml')),
    readText(resolve(projectRoot, 'go.mod')),
  ]);

  const configStacks: DetectedStack[] = [];

  // Parse each config
  if (pkgResult.status === 'fulfilled' && pkgResult.value) {
    configStacks.push(parsePackageJson(pkgResult.value, projectRoot));
  }
  if (composerResult.status === 'fulfilled' && composerResult.value) {
    configStacks.push(parseComposerJson(composerResult.value, projectRoot));
  }
  if (cargoResult.status === 'fulfilled' && cargoResult.value) {
    const stack = parseCargoToml(cargoResult.value);
    if (stack) configStacks.push(stack);
  }
  if (pyResult.status === 'fulfilled' && pyResult.value) {
    const stack = parsePyprojectToml(pyResult.value);
    if (stack) configStacks.push(stack);
  }
  if (goResult.status === 'fulfilled' && goResult.value) {
    const stack = parseGoMod(goResult.value);
    if (stack) configStacks.push(stack);
  }

  // Determine primary stack
  const primaryStack = configStacks.length === 1
    ? configStacks[0]
    : configStacks.length > 1
      ? determinePrimary(configStacks)
      : undefined;

  // Determine confidence
  const confidence = determineConfidence(astIndexType, configStacks);

  // Detect quality tools and CI
  const [qualityTools, ciPipelines, hasDocker] = await Promise.all([
    detectQualityTools(projectRoot),
    detectCI(projectRoot),
    detectDocker(projectRoot),
  ]);

  // Project identity from primary stack
  const projectName = primaryStack?.name ?? basename(projectRoot);
  const projectVersion = primaryStack?.version ?? '0.0.0';
  const projectDescription = primaryStack?.description;

  return {
    projectName,
    projectVersion,
    projectDescription,
    astIndexType,
    configStacks,
    primaryStack,
    confidence,
    qualityTools,
    ciPipelines,
    hasDocker,
  };
}

// ──────────────────────────────────────────────
// Config parsers
// ──────────────────────────────────────────────

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

interface ComposerJson {
  name?: string;
  version?: string;
  description?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

function parsePackageJson(pkg: PackageJson, projectRoot: string): DetectedStack {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFramework(allDeps, JS_FRAMEWORKS);
  const nodeVersion = pkg.engines?.node;

  return {
    type: 'Node.js/TypeScript',
    name: pkg.name ?? basename(projectRoot),
    version: pkg.version ?? '0.0.0',
    langVersion: nodeVersion ? `Node ${normalizeVersionConstraint(nodeVersion)}` : undefined,
    framework: framework ? formatFramework(framework, allDeps) : undefined,
    description: pkg.description,
  };
}

function parseComposerJson(composer: ComposerJson, projectRoot: string): DetectedStack {
  const allDeps = { ...composer.require, ...composer['require-dev'] };
  const framework = detectFramework(allDeps, PHP_FRAMEWORKS);
  const phpVersion = composer.require?.['php'];

  return {
    type: 'PHP',
    name: composer.name ?? basename(projectRoot),
    version: composer.version ?? '0.0.0',
    langVersion: phpVersion ? `PHP ${normalizeVersionConstraint(phpVersion)}` : undefined,
    framework: framework ? formatFramework(framework, allDeps) : undefined,
    description: composer.description,
  };
}

function parseCargoToml(text: string): DetectedStack | null {
  const name = text.match(/^name\s*=\s*"(.+?)"/m)?.[1];
  const version = text.match(/^version\s*=\s*"(.+?)"/m)?.[1];
  if (!name && !version) return null;
  return {
    type: 'Rust',
    name: name ?? 'unknown',
    version: version ?? '0.0.0',
  };
}

function parsePyprojectToml(text: string): DetectedStack | null {
  const name = text.match(/^name\s*=\s*"(.+?)"/m)?.[1];
  const version = text.match(/^version\s*=\s*"(.+?)"/m)?.[1];
  if (!name && !version) return null;

  // Try to detect framework from dependencies
  let framework: string | undefined;
  for (const [pkg, fw] of Object.entries(PYTHON_FRAMEWORKS)) {
    if (text.includes(`"${pkg}`) || text.includes(`'${pkg}`)) {
      framework = fw;
      break;
    }
  }

  // Python version
  const pyVersion = text.match(/requires-python\s*=\s*"(.+?)"/)?.[1];

  return {
    type: 'Python',
    name: name ?? 'unknown',
    version: version ?? '0.0.0',
    langVersion: pyVersion ? `Python ${normalizeVersionConstraint(pyVersion)}` : undefined,
    framework,
  };
}

function parseGoMod(text: string): DetectedStack | null {
  const module = text.match(/^module\s+(.+)/m)?.[1]?.trim();
  if (!module) return null;

  // Go version
  const goVersion = text.match(/^go\s+(\S+)/m)?.[1];

  return {
    type: 'Go',
    name: module,
    version: '0.0.0',
    langVersion: goVersion ? `Go ${goVersion}` : undefined,
  };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function detectFramework(
  deps: Record<string, string> | undefined,
  frameworkMap: Record<string, string>,
): { name: string; pkg: string } | null {
  if (!deps) return null;
  for (const [pkg, name] of Object.entries(frameworkMap)) {
    if (deps[pkg]) return { name, pkg };
  }
  return null;
}

function formatFramework(
  fw: { name: string; pkg: string },
  deps: Record<string, string>,
): string {
  const versionConstraint = deps[fw.pkg];
  if (!versionConstraint) return fw.name;

  // Extract major version from constraint: "^12.0" → "12", "~3.4" → "3"
  const majorMatch = versionConstraint.match(/(\d+)/);
  return majorMatch ? `${fw.name} ${majorMatch[1]}` : fw.name;
}

/**
 * Normalize version constraint to human-readable form.
 * ">=8.2" → "8.2+", "^8.2" → "8.2+", "~8.2" → "8.2+", "8.2.*" → "8.2+"
 */
function normalizeVersionConstraint(constraint: string): string {
  const cleaned = constraint.replace(/[>=^~*|<\s]/g, '').split(',')[0].split('|')[0];
  // Take first version-like segment
  const version = cleaned.match(/\d+(\.\d+)*/)?.[0];
  return version ? `${version}+` : constraint;
}

/**
 * Determine primary stack when multiple configs found.
 * Heuristic: backend languages (PHP, Python, Go, Rust) beat JS/TS as primary
 * because JS/TS in multi-stack projects is typically frontend tooling.
 */
function determinePrimary(stacks: DetectedStack[]): DetectedStack {
  // Backend-first priority
  const priority = ['PHP', 'Python', 'Go', 'Rust', 'Node.js/TypeScript'];
  const sorted = [...stacks].sort(
    (a, b) => priority.indexOf(a.type) - priority.indexOf(b.type),
  );
  return sorted[0];
}

/**
 * Determine confidence level based on agreement between ast-index and config detection.
 */
function determineConfidence(
  astIndexType: string | undefined,
  configStacks: DetectedStack[],
): 'high' | 'medium' | 'low' | 'unknown' {
  if (!astIndexType && configStacks.length === 0) return 'unknown';
  if (!astIndexType) return configStacks.length === 1 ? 'medium' : 'medium';
  if (configStacks.length === 0) return 'medium';

  // Check if ast-index type matches any config stack
  const astLower = astIndexType.toLowerCase();
  const anyMatch = configStacks.some(s => {
    const typeLower = s.type.toLowerCase();
    return astLower.includes(typeLower) || typeLower.includes(astLower)
      || (astLower.includes('javascript') && typeLower.includes('node'))
      || (astLower.includes('typescript') && typeLower.includes('node'))
      || (astLower.includes('php') && typeLower === 'php');
  });

  if (anyMatch && configStacks.length === 1) return 'high';
  if (anyMatch && configStacks.length > 1) return 'medium';
  return 'low'; // Conflict: ast-index says X, configs say Y
}

// ──────────────────────────────────────────────
// Quality & CI detection
// ──────────────────────────────────────────────

/** Detect quality/linting tools present in project root */
export async function detectQualityTools(projectRoot: string): Promise<string[]> {
  const tools: string[] = [];

  const checks: Array<{ files: string[]; name: string }> = [
    { files: ['phpstan.neon', 'phpstan.neon.dist'], name: 'PHPStan' },
    { files: ['psalm.xml', 'psalm.xml.dist'], name: 'Psalm' },
    { files: ['phpunit.xml', 'phpunit.xml.dist'], name: 'PHPUnit' },
    { files: ['pest.php'], name: 'Pest' },
    { files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'], name: 'ESLint' },
    { files: ['tsconfig.json'], name: 'TypeScript' },
    { files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'], name: 'Vitest' },
    { files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs'], name: 'Jest' },
    { files: ['biome.json', 'biome.jsonc'], name: 'Biome' },
    { files: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js'], name: 'Prettier' },
    { files: ['deptrac.yaml', 'deptrac.yml'], name: 'Deptrac' },
    { files: ['rector.php'], name: 'Rector' },
    { files: ['ruff.toml', '.ruff.toml'], name: 'Ruff' },
  ];

  const results = await Promise.allSettled(
    checks.map(async (check) => {
      for (const file of check.files) {
        try {
          await access(resolve(projectRoot, file));
          return check.name;
        } catch { /* file doesn't exist */ }
      }
      return null;
    }),
  );

  // Special case: Ruff can also be configured in pyproject.toml [tool.ruff]
  // Only check if ruff.toml/.ruff.toml not already found
  const ruffFound = results.some(r => r.status === 'fulfilled' && r.value === 'Ruff');
  if (!ruffFound) {
    try {
      const pyprojectPath = resolve(projectRoot, 'pyproject.toml');
      const content = await readFile(pyprojectPath, 'utf-8');
      if (content.includes('[tool.ruff]')) {
        // Inject Ruff into results manually below
        results.push({ status: 'fulfilled', value: 'Ruff' } as PromiseFulfilledResult<string>);
      }
    } catch { /* no pyproject.toml or can't read */ }
  }

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      tools.push(r.value);
    }
  }

  return tools;
}

/** Detect CI/CD pipelines present in project */
export async function detectCI(projectRoot: string): Promise<string[]> {
  const pipelines: string[] = [];

  // GitHub Actions
  try {
    const ghDir = resolve(projectRoot, '.github', 'workflows');
    const files = await readdir(ghDir);
    const ymlCount = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).length;
    if (ymlCount > 0) {
      pipelines.push(`GitHub Actions (${ymlCount} workflow${ymlCount > 1 ? 's' : ''})`);
    }
  } catch { /* no .github/workflows */ }

  // GitLab CI
  try {
    await access(resolve(projectRoot, '.gitlab-ci.yml'));
    pipelines.push('GitLab CI');
  } catch { /* no gitlab ci */ }

  // Other CI
  const otherCI: Array<{ file: string; name: string }> = [
    { file: 'Jenkinsfile', name: 'Jenkins' },
    { file: '.circleci/config.yml', name: 'CircleCI' },
    { file: 'bitbucket-pipelines.yml', name: 'Bitbucket Pipelines' },
    { file: '.travis.yml', name: 'Travis CI' },
  ];

  for (const ci of otherCI) {
    try {
      await access(resolve(projectRoot, ci.file));
      pipelines.push(ci.name);
    } catch { /* not present */ }
  }

  return pipelines;
}

/** Detect Docker presence */
export async function detectDocker(projectRoot: string): Promise<boolean> {
  const dockerFiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const file of dockerFiles) {
    try {
      await access(resolve(projectRoot, file));
      return true;
    } catch { /* not present */ }
  }
  return false;
}

// ──────────────────────────────────────────────
// File reading helpers
// ──────────────────────────────────────────────

async function readJSON<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
