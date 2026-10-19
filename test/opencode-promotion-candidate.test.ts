import { describe, expect, it } from 'vitest';
import { forkReleaseIdentity, publishedForkReleases, selectPromotionCandidate } from '../scripts/opencode-promotion-candidate.mjs';

const sha = (character: string) => character.repeat(40);

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'mem-preview-20261018-trim-web-serve-17355bd',
    target_commitish: sha('1'),
    published_at: '2026-10-18T22:30:00Z',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'opencode-linux-x64.tar.gz', digest: `sha256:${'a'.repeat(64)}` },
      { name: 'opencode-linux-x64.tar.gz.sha256' },
    ],
    ...overrides,
  };
}

describe('OpenCode fork promotion candidate', () => {
  it('reads tag, date, source commit and archive digest from a published release', () => {
    expect(forkReleaseIdentity(release())).toEqual({
      tag: 'mem-preview-20261018-trim-web-serve-17355bd',
      date: '20261018',
      sourceCommit: sha('1'),
      archiveSha256: 'a'.repeat(64),
      publishedAt: '2026-10-18T22:30:00Z',
    });
  });

  it('ignores drafts, prereleases, foreign tags and undated releases', () => {
    const kept = release();
    const releases = [
      kept,
      release({ draft: true }),
      release({ prerelease: true }),
      release({ tag_name: 'mem-v20261018-17355bd' }),
      release({ tag_name: 'v1.0.0' }),
      release({ published_at: 'not-a-date' }),
    ];
    expect(publishedForkReleases(releases)).toEqual([kept]);
  });

  it('refuses a release that cannot be verified instead of promoting it', () => {
    expect(() => forkReleaseIdentity(release({ target_commitish: '17355bd' }))).toThrow('full source commit');
    expect(() => forkReleaseIdentity(release({ assets: [{ name: 'opencode-linux-x64.tar.gz' }] }))).toThrow('checksum');
    expect(() => forkReleaseIdentity(release({ assets: [{ name: 'opencode-linux-x64.tar.gz', digest: 'sha256:short' }, { name: 'opencode-linux-x64.tar.gz.sha256' }] }))).toThrow('sha256 digest');
    expect(() => forkReleaseIdentity(release({ tag_name: 'nightly' }))).toThrow('Not a mem-preview');
  });

  it('proposes a candidate only when the source commit differs from the active build', () => {
    const decision = selectPromotionCandidate([release()], { sourceCommit: sha('9'), tag: 'mem-preview-20261010-old-aaaaaaa' });
    expect(decision.status).toBe('candidate');
    expect(decision.candidate.sourceCommit).toBe(sha('1'));
    expect(decision.reason).toContain('differs from the active build');
  });

  it('reports up-to-date when the latest published release is the active build', () => {
    const decision = selectPromotionCandidate([release()], { sourceCommit: sha('1'), tag: 'mem-preview-20261018-trim-web-serve-17355bd' });
    expect(decision.status).toBe('up-to-date');
  });

  it('refuses to roll back when the active build is newer than the latest published release', () => {
    const decision = selectPromotionCandidate([release()], { sourceCommit: sha('9'), tag: 'mem-preview-20261019-newer-9999999' });
    expect(decision.status).toBe('downgrade');
    expect(decision.reason).toContain('refusing to roll back');
  });

  it('requires a full active source commit and at least one published release', () => {
    expect(() => selectPromotionCandidate([release()], { sourceCommit: '17355bd' })).toThrow('full 40-character Git SHA');
    expect(() => selectPromotionCandidate([], { sourceCommit: sha('9') })).toThrow('No published mem-preview');
  });
});
