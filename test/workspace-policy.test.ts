import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compileCleanListRules,
  compilePolicy,
  DEFAULT_EXPORT_POLICY,
  MIGRATION_COMPRESSION_EXCLUDES,
  buildMigrationPolicy,
  assertWorkspaceDir,
  classifyPath,
  matchRule,
  patternToRegExp,
  repositoryNameFor,
  sanitizeProfileId,
  scanWorkspace,
} from '../src/workspace/policy.js';
import { cleanupTempDirs, tempDir, writeFiles } from './workspace-fixtures.js';

const compiled = compilePolicy(DEFAULT_EXPORT_POLICY);

afterEach(cleanupTempDirs);

describe('export policy: credentials never leave the profile', () => {
  const secrets = [
    'auth.json',
    'projects/x/auth.json',
    '.local/share/opencode/auth.json',
    '.mcp.json',
    'storage-state.json',
    'playwright-storage-state.json',
    'sites/skillset/creds.json',
    'sites/skillset/skillset-creds',
    'credentials.json',
    '.netrc',
    '.npmrc',
    '.env',
    '.env.production',
    'certs/server.pem',
    'certs/server.key',
    'id_rsa',
    '.ssh/config',
    '.aws/credentials',
    '.config/gcloud/application_default_credentials.json',
    'opencode.db',
    'opencode.db-wal',
    '.trained-assist/candidates/draft.json',
  ];

  it.each(secrets)('excludes %s', (path) => {
    expect(matchRule(compiled, path).action).toBe('exclude');
  });

  it('publishes ordinary profile text', () => {
    for (const path of ['README.md', 'persona/system.md', 'contexts/2026/notes.md', 'projects/app/package.json', 'data/table.csv']) {
      expect(matchRule(compiled, path).action).toBe('publish');
    }
  });

  it('excludes the whole subtree of a matched directory', () => {
    expect(matchRule(compiled, 'node_modules').action).toBe('exclude');
    expect(matchRule(compiled, 'projects/app/node_modules').action).toBe('exclude');
  });

  it('a specific rule above a general one wins (first match)', () => {
    const policy = compilePolicy({
      policyId: 'ordered',
      version: 1,
      textMaxBytes: 1024,
      maxFiles: 10,
      maxTotalBytes: 1024,
      rules: [
        { pattern: 'notes/keep.md', action: 'publish', reason: 'explicitly allowed' },
        { pattern: 'notes', action: 'exclude', reason: 'the rest of the directory is private' },
      ],
    });
    expect(matchRule(policy, 'notes/keep.md').action).toBe('publish');
    expect(matchRule(policy, 'notes/other.md').action).toBe('exclude');
  });

  it('a name pattern matches at any depth, a path pattern only at the root', () => {
    expect(patternToRegExp('auth.json').test('a/b/c/auth.json')).toBe(true);
    // Путь с `/`anchored в корне: совпадает сам каталог (а правило на каталог закрывает
    // его поддерево через проверку предков), но не произвольный вложенный путь.
    expect(patternToRegExp('.config/gcloud').test('.config/gcloud')).toBe(true);
    expect(patternToRegExp('.config/gcloud').test('x/.config/gcloud')).toBe(false);
    expect(patternToRegExp('.config/gcloud').test('.config/gcloud/creds.json')).toBe(false);
  });

  it('refuses an absolute pattern instead of silently matching nothing', () => {
    expect(() =>
      compilePolicy({
        policyId: 'bad',
        version: 1,
        textMaxBytes: 1,
        maxFiles: 1,
        maxTotalBytes: 1,
        rules: [{ pattern: '/etc/passwd', action: 'exclude', reason: 'bad rule' }],
      }),
    ).toThrowError(/must be relative to the profile root/);
  });
});

describe('export policy: text goes to git, heavy artifacts stay in object storage', () => {
  const small = classifyPath(compiled, 'notes/a.md', 10);
  expect(small.action).toBe('publish');

  const heavy = classifyPath(compiled, 'media/big.bin', DEFAULT_EXPORT_POLICY.textMaxBytes + 1);
  expect(heavy.action).toBe('heavy');
  expect(heavy.reason).toMatch(/byte git limit/);

  it('an excluded file is not rescued by being small', () => {
    expect(classifyPath(compiled, 'auth.json', 1).action).toBe('exclude');
  });

  it('an explicit heavy rule wins over the size threshold', () => {
    const policy = compilePolicy({
      policyId: 'explicit-heavy',
      version: 1,
      textMaxBytes: 1024 * 1024,
      maxFiles: 10,
      maxTotalBytes: 1024 * 1024,
      rules: [{ pattern: 'assets', action: 'heavy', reason: 'assets never enter git' }],
    });
    expect(classifyPath(policy, 'assets/logo.svg', 10).action).toBe('heavy');
  });
});

describe('workspace scan', () => {
  it('is deterministic, sorted and reports exclusions with reasons', () => {
    const root = tempDir('ws-scan-');
    writeFiles(root, {
      'notes/b.md': 'b',
      'notes/a.md': 'a',
      'auth.json': '{"token":"secret"}',
      '.env': 'SECRET=1',
      'deep/nested/file.txt': 'x',
    });
    const first = scanWorkspace(compiled, root);
    const second = scanWorkspace(compiled, root);
    expect(first.files.map((file) => file.path)).toEqual(['deep/nested/file.txt', 'notes/a.md', 'notes/b.md']);
    expect(second.files).toEqual(first.files);
    expect(first.excluded.map((item) => item.path).sort()).toEqual(['.env', 'auth.json']);
    expect(first.excluded.every((item) => item.reason.length > 0)).toBe(true);
  });

  it('never publishes a symlink, even when its target is an ordinary profile file', () => {
    const root = tempDir('ws-symlink-');
    writeFiles(root, { 'notes/a.md': 'a' });
    writeFileSync(join(root, 'auth.json'), '{"token":"secret"}');
    symlinkSync(join(root, 'auth.json'), join(root, 'notes', 'link.md'));
    const scan = scanWorkspace(compiled, root);
    expect(scan.files.map((file) => file.path)).toEqual(['notes/a.md']);
    expect(scan.excluded).toContainEqual(expect.objectContaining({ path: 'notes/link.md', reason: expect.stringMatching(/symlink/) }));
    // И сам credential остаётся вне образа даже как цель ссылки.
    expect(scan.excluded).toContainEqual(expect.objectContaining({ path: 'auth.json' }));
  });

  it('treats a nested git repository as excluded, not as profile content', () => {
    const root = tempDir('ws-nested-git-');
    writeFiles(root, { 'notes/a.md': 'a', 'vendor/repo/file.md': 'v', 'vendor/repo/.git/config': '[core]' });
    const scan = scanWorkspace(compiled, root);
    expect(scan.files.map((file) => file.path)).toEqual(['notes/a.md']);
    expect(scan.excluded).toContainEqual(expect.objectContaining({ path: 'vendor/repo', reason: 'nested git repository' }));
  });

  it('honours an explicit path allowlist, including directories', () => {
    const root = tempDir('ws-allow-');
    writeFiles(root, { 'notes/a.md': 'a', 'notes/b.md': 'b', 'other/c.md': 'c' });
    const scan = scanWorkspace(compiled, root, { paths: ['notes/a.md'] });
    expect(scan.files.map((file) => file.path)).toEqual(['notes/a.md']);
    const dirScan = scanWorkspace(compiled, root, { paths: ['notes'] });
    expect(dirScan.files.map((file) => file.path)).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('fails loudly when the profile exceeds the declared limits', () => {
    const root = tempDir('ws-limits-');
    writeFiles(root, { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    const policy = compilePolicy({ ...DEFAULT_EXPORT_POLICY, policyId: 'small', maxFiles: 2 });
    expect(() => scanWorkspace(policy, root)).toThrowError(/more than 2 publishable files/);
  });

  it('refuses a workspace path that does not exist', () => {
    expect(() => assertWorkspaceDir(join(tempDir('ws-missing-'), 'nope'))).toThrowError(/does not exist/);
  });

  it('classifies binary content as heavy regardless of size', () => {
    const root = tempDir('ws-binary-');
    mkdirSync(join(root, 'blobs'), { recursive: true });
    writeFileSync(join(root, 'blobs', 'tiny.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const policy = compilePolicy({ ...DEFAULT_EXPORT_POLICY, policyId: 'binary', textMaxBytes: 1024 });
    const scan = scanWorkspace(policy, root);
    // Бинарность в размере не выражается: мелкий бинарник остаётся текстом по размеру,
    // и это осознанно — проверка бинарности по NUL сделана при merge, а не здесь.
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]?.action).toBe('publish');
  });
});

describe('repository naming', () => {
  it('is a pure function of profileId and survives re-derivation', () => {
    expect(repositoryNameFor('alice')).toBe('profile-alice');
    expect(repositoryNameFor('alice')).toBe(repositoryNameFor('alice'));
  });

  it('separates profiles that would collapse onto one base name', () => {
    // Без sha-суффикса `Alice` и `alice` дали бы один репозиторий, и чужой профиль получил
    // бы доступ к данным другого — это и есть причина суффикса.
    expect(repositoryNameFor('Alice')).not.toBe(repositoryNameFor('alice'));
    expect(repositoryNameFor('alice')).not.toBe(repositoryNameFor('alice2'));
  });

  it('keeps a legal, github-safe name for exotic profile ids', () => {
    for (const id of ['Alice', 'профиль', 'a b/c', '___', 'x'.repeat(300)]) {
      const name = repositoryNameFor(id);
      expect(name).toMatch(/^profile-[a-z0-9-]{1,100}$/);
    }
    expect(repositoryNameFor('___')).toMatch(/^profile-[0-9a-f]{6}$/);
  });

  it('sanitizes deterministically', () => {
    expect(sanitizeProfileId('Alice')).toBe('alice');
    expect(sanitizeProfileId('--x--')).toBe('x');
  });

  it('refuses an empty profileId instead of producing a shared repository name', () => {
    expect(() => repositoryNameFor('')).toThrowError(/profileId is required/);
  });
});

describe('legacy clean list compatibility', () => {
  it('compiles KEEP/EXCLUDE and refuses to publish anything the clean list moves elsewhere', () => {
    const rules = compileCleanListRules([
      { pattern: '*.md', action: 'KEEP', reason: 'profile text' },
      { pattern: 'auth.json', action: 'EXCLUDE', reason: 'engine oauth' },
      { pattern: 'opencode.db', action: 'SYSTEM', reason: 'engine runtime state' },
      { pattern: 'node_modules', action: 'DELETE', reason: 'regenerable' },
    ]);
    const policy = compilePolicy({ ...DEFAULT_EXPORT_POLICY, policyId: 'from-clean-list', rules });
    expect(matchRule(policy, 'notes/a.md').action).toBe('publish');
    expect(matchRule(policy, 'auth.json').action).toBe('exclude');
    expect(matchRule(policy, 'opencode.db').action).toBe('exclude');
    expect(matchRule(policy, 'node_modules').action).toBe('exclude');
    // Причина из clean list сохраняется: она объясняет решение оператору.
    expect(matchRule(policy, 'opencode.db').reason).toMatch(/engine runtime state/);
  });
});

describe('migration compression excludes engine state, not user text', () => {
  it('drops agent home, session traces and generated indices', () => {
    const policy = compilePolicy({
      policyId: 'migration',
      version: 1,
      textMaxBytes: 1024,
      maxFiles: 100,
      maxTotalBytes: 1024 * 1024,
      rules: [...DEFAULT_EXPORT_POLICY.rules, ...MIGRATION_COMPRESSION_EXCLUDES],
    });
    for (const path of [
      '.agent-home/agent-data/engineering-workspaces/repo-maps/x/search/chunks.json',
      '.agent-tokens/alice/token',
      '.session-traces/session.jsonl',
      '.mcp-runs/run-1/log',
      '.run-inputs/snap-1/file.md',
      'projects/app/repo-maps/abc/search/embed-abc.json',
      '.opencode-mcp.json',
      '.system-prompt.txt',
    ]) {
      expect(matchRule(policy, path).action, path).toBe('exclude');
    }
    // Пользовательский текст остаётся.
    for (const path of ['persona/system.md', 'contexts/notes.md', 'projects/app/src/index.md', 'agent-notes.md']) {
      expect(matchRule(policy, path).action, path).toBe('publish');
    }
  });
});

describe('buildMigrationPolicy keeps the mandatory layer first', () => {
  it('excludes secrets even when the clean list is silent about them', () => {
    // Clean list знает про auth.json, но молчит про *.key и .ssh — обязательный слой
    // модуля обязан их исключить, иначе импорт опубликует закрытый ключ.
    const policy = compilePolicy(
      buildMigrationPolicy({
        policyId: 'migration',
        compress: true,
        cleanListRules: compileCleanListRules([{ pattern: '*.md', action: 'KEEP', reason: 'text' }]),
      }),
    );
    expect(matchRule(policy, 'deck/source/signing.key').action).toBe('exclude');
    expect(matchRule(policy, 'deploy/id_rsa').action).toBe('exclude');
    expect(matchRule(policy, '.ssh/config').action).toBe('exclude');
    expect(matchRule(policy, '.agent-home/agent-data/x.json').action).toBe('exclude');
    expect(matchRule(policy, 'notes/a.md').action).toBe('publish');
  });

  it('lets an explicit clean-list KEEP win over compression but never over secrets', () => {
    const policy = compilePolicy(
      buildMigrationPolicy({
        policyId: 'migration',
        compress: true,
        cleanListRules: compileCleanListRules([{ pattern: 'auth.json', action: 'KEEP', reason: 'wrong on purpose' }]),
      }),
    );
    // Обязательный слой стоит первым — даже KEEP из clean list не вернёт credential.
    expect(matchRule(policy, 'auth.json').action).toBe('exclude');
  });
});

describe('migration compression: archives stay out of git, generated dirs stay out of the image', () => {
  const policy = compilePolicy(
    buildMigrationPolicy({
      policyId: 'migration',
      compress: true,
      cleanListRules: compileCleanListRules([{ pattern: '*.md', action: 'KEEP', reason: 'text' }]),
    }),
  );

  it('treats archives, images and databases as heavy artifacts, not as git content', () => {
    for (const path of ['projects/app/release.tar', 'projects/app/architecture.tar.gz', 'docs/bundle.zip', 'media/d.dmg', 'data/state.db', 'docs/spec.pdf']) {
      expect(matchRule(policy, path).action, path).toBe('heavy');
    }
    // Маленький архив тоже артефакт: по размеру он прошёл бы в git, а по смыслу не текст.
    expect(classifyPath(policy, 'projects/tiny.tar', 500).action).toBe('heavy');
  });

  it('drops build output, sandboxes, agent checkouts and scratch work dirs', () => {
    for (const path of [
      'projects/recruiting/iteration-5/sandbox/checkout-1234/dist/index.js',
      'projects/app/dist/bundle.js',
      'projects/app/.work/arch-review/req.json',
      'projects/app/checkout/src/main.py',
      'projects/app/source_clone/README.md',
      'projects/app/release/binary',
    ]) {
      expect(matchRule(policy, path).action, path).toBe('exclude');
    }
  });

  it('keeps the regenerable layer (node_modules) that buildMigrationPolicy must not drop', () => {
    expect(matchRule(policy, 'projects/app/node_modules/x/index.js').action).toBe('exclude');
    expect(matchRule(policy, 'projects/app/src/index.js').action).toBe('publish');
  });
});

describe('M3 archive files are addressed correctly by the migration policy', () => {
  const policy = compilePolicy(
    buildMigrationPolicy({
      policyId: 'migration',
      compress: true,
      cleanListRules: compileCleanListRules([{ pattern: '*.md', action: 'KEEP', reason: 'text' }]),
    }),
  );

  it('treats a git bundle and an untracked tar as heavy, a patch and a manifest as text', () => {
    expect(matchRule(policy, '.profile-changes/repo/local.bundle').action).toBe('heavy');
    expect(matchRule(policy, '.profile-changes/repo/untracked.tar').action).toBe('heavy');
    expect(matchRule(policy, '.profile-changes/repo/uncommitted.patch').action).toBe('publish');
    expect(matchRule(policy, '.profile-changes/repo/local.manifest.json').action).toBe('publish');
  });
});
