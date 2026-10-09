import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const script = join(process.cwd(), 'scripts/enable-api-sandbox-mock-test.py');
const python = `import importlib.util,pathlib,sys\nspec=importlib.util.spec_from_file_location('envtool',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\ntry:\n changed=module.enable_mock_test(pathlib.Path(sys.argv[2]))\n print('changed' if changed else 'unchanged')\nexcept Exception as error:\n print(str(error))\n raise SystemExit(4)`;

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'runner-sandbox-env-'));
  directories.push(dir);
  const path = join(dir, 'service.env');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function update(path: string): string {
  return execFileSync('python3', ['-c', python, script, path], { encoding: 'utf8' }).trim();
}

function updateFailure(path: string): string {
  try { update(path); } catch (error) {
    const result = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = (value?: string | Buffer) => typeof value === 'string' ? value : value?.toString('utf8') ?? '';
    return output(result.stdout) + output(result.stderr);
  }
  throw new Error('expected sandbox environment update to fail');
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sandbox mock-test environment provisioning', () => {
  it('enables only the named sandbox flags, preserves unrelated bindings and is idempotent', () => {
    const path = fixture('AGENT_API_PORT=18882\nEXTERNAL_WORKER_TOKEN=opaque\nAGENT_API_ENVIRONMENT=dev\nAGENT_API_ENVIRONMENT=test\n');
    expect(update(path)).toBe('changed');
    const first = readFileSync(path, 'utf8');
    expect(first).toContain('EXTERNAL_WORKER_TOKEN=opaque');
    expect(first.match(/^AGENT_API_ENVIRONMENT=sandbox$/gm)).toHaveLength(1);
    expect(first.match(/^AGENT_API_ENABLE_MOCK_TEST=true$/gm)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(update(path)).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('rejects production and symlinked environment targets without changing their contents', () => {
    const production = fixture('NODE_ENV=production\nAGENT_API_ENVIRONMENT=production\n');
    const before = readFileSync(production, 'utf8');
    expect(updateFailure(production)).toContain('mock_test_forbidden_in_production');
    expect(readFileSync(production, 'utf8')).toBe(before);

    const quotedProduction = fixture('NODE_ENV="production"\n');
    expect(updateFailure(quotedProduction)).toContain('mock_test_forbidden_in_production');

    const openMode = join(tmpdir(), `runner-sandbox-env-open-${process.pid}`);
    writeFileSync(openMode, 'AGENT_API_PORT=18882\n', { mode: 0o644 });
    chmodSync(openMode, 0o644);
    directories.push(openMode);
    expect(updateFailure(openMode)).toContain('sandbox_environment_permissions_too_open');

    const linked = join(tmpdir(), `runner-sandbox-env-link-${process.pid}`);
    symlinkSync(production, linked);
    directories.push(linked);
    expect(updateFailure(linked)).toContain('sandbox_environment_not_regular_file');
    expect(readFileSync(production, 'utf8')).toBe(before);
  });
});
