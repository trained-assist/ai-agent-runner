import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCleanList, cleanListRulesOf } from '../src/workspace/clean-list.js';
import { compileCleanListRules } from '../src/workspace/policy.js';
import { compilePolicy, matchRule } from '../src/workspace/policy.js';

const CLEAN_LIST = `
version: 2

rules:
  - pattern: node_modules
    action: DELETE
    reason: "regenerable"

  - pattern: auth.json
    action: EXCLUDE
    reason: "engine oauth"

  - pattern: sessions
    action: ARCHIVE
    reason: "session bodies live in object storage"

  - pattern: "*.md"
    action: KEEP
    reason: "profile text image"

  - pattern: opencode.db
    action: SYSTEM
    reason: "engine runtime state"
`;

describe('clean list parser', () => {
  it('parses the documented subset', () => {
    const parsed = parseCleanList(CLEAN_LIST);
    expect(parsed.version).toBe(2);
    expect(parsed.rules).toHaveLength(5);
    expect(parsed.rules[1]).toMatchObject({ pattern: 'auth.json', action: 'EXCLUDE', reason: 'engine oauth' });
  });

  it('compiles into an export policy that keeps the text image and drops sessions', () => {
    const policy = compilePolicy({
      policyId: 'from-clean-list',
      version: 1,
      textMaxBytes: 1024,
      maxFiles: 100,
      maxTotalBytes: 1024 * 1024,
      rules: compileCleanListRules(cleanListRulesOf(parseCleanList(CLEAN_LIST))),
    });
    expect(matchRule(policy, 'persona/system.md').action).toBe('publish');
    expect(matchRule(policy, 'notes/a.md').action).toBe('publish');
    expect(matchRule(policy, 'sessions/s-web-1.json').action).toBe('exclude');
    expect(matchRule(policy, 'auth.json').action).toBe('exclude');
    expect(matchRule(policy, 'opencode.db').action).toBe('exclude');
    expect(matchRule(policy, 'node_modules/x.js').action).toBe('exclude');
  });

  it('fails loud on an unknown action instead of guessing', () => {
    expect(() => parseCleanList('version: 2\nrules:\n  - pattern: x\n    action: MYSTERY\n    reason: r\n')).toThrowError(/unknown action/);
  });

  it('fails loud on an unknown field, a missing reason and a missing version', () => {
    expect(() => parseCleanList('version: 2\nrules:\n  - pattern: x\n    action: KEEP\n    reason: r\n    weight: 3\n')).toThrowError(/unknown field/);
    expect(() => parseCleanList('version: 2\nrules:\n  - pattern: x\n    action: KEEP\n')).toThrowError(/missing "reason"/);
    expect(() => parseCleanList('rules:\n  - pattern: x\n    action: KEEP\n    reason: r\n')).toThrowError(/missing "version"/);
  });

  it('fails loud on a rule before "rules:" and on an empty file', () => {
    expect(() => parseCleanList('version: 2\n  - pattern: x\n    action: KEEP\n    reason: r\n')).toThrowError(/before "rules:"/);
    expect(() => parseCleanList('')).toThrowError(/empty/);
  });

  it('keeps the reason text so the policy explains its decisions', () => {
    const parsed = parseCleanList(CLEAN_LIST);
    const policy = compilePolicy({
      policyId: 'x',
      version: 1,
      textMaxBytes: 1,
      maxFiles: 1,
      maxTotalBytes: 1,
      rules: compileCleanListRules(cleanListRulesOf(parsed)),
    });
    expect(matchRule(policy, 'sessions/a.json').reason).toMatch(/object storage/);
  });
});

describe('clean list preconditions (when: git-repo)', () => {
  it('applies a git-repo rule only inside a working copy', () => {
    const policy = compilePolicy({
      policyId: 'conditional',
      version: 1,
      textMaxBytes: 1024,
      maxFiles: 100,
      maxTotalBytes: 1024 * 1024,
      rules: [
        { pattern: '**', action: 'exclude', reason: 'working copies are archived', when: 'git-repo' },
        { pattern: '*.md', action: 'publish', reason: 'profile text' },
      ],
    });
    // Внутри рабочей копии `**` закрывает всё.
    expect(matchRule(policy, 'notes/a.md', { insideGitRepo: true }).action).toBe('exclude');
    // Вне рабочей копии правило не действует: профиль публикуется.
    expect(matchRule(policy, 'notes/a.md', { insideGitRepo: false }).action).toBe('publish');
    expect(matchRule(policy, 'notes/a.md').action).toBe('publish');
  });

  it('detects a working copy by an ancestor .git directory', async () => {
    const { isInsideGitRepo } = await import('../src/workspace/policy.js');
    const root = mkdtempSync(join(tmpdir(), 'policy-git-'));
    expect(isInsideGitRepo(root)).toBe(false);
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true });
    expect(isInsideGitRepo(join(root, 'nested', 'deep'))).toBe(false);
    mkdirSync(join(root, '.git'), { recursive: true });
    expect(isInsideGitRepo(join(root, 'nested', 'deep'))).toBe(true);
  });

  it('refuses an unknown precondition instead of ignoring it', () => {
    expect(() =>
      compilePolicy({
        policyId: 'bad',
        version: 1,
        textMaxBytes: 1,
        maxFiles: 1,
        maxTotalBytes: 1,
        rules: [{ pattern: 'x', action: 'exclude', reason: 'r', when: 'on-full-moon' as never }],
      }),
    ).toThrowError(/unsupported "when" precondition/);
  });
});
