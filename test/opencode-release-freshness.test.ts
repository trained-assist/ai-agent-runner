import { describe, expect, it } from 'vitest';
import { assertOpenCodeReleaseFreshness, latestOpenCodePreview } from '../scripts/assert-opencode-release-freshness.mjs';

const sourceSha = 'a'.repeat(40);
const archiveSha256 = 'b'.repeat(64);
const releases = [
  { tag_name: 'mem-preview-20261014-old', published_at: '2026-10-14T10:00:00Z', draft: false, target_commitish: 'c'.repeat(40), assets: [] },
  { tag_name: 'mem-preview-20261016-draft', published_at: '2026-10-16T10:00:00Z', draft: true, target_commitish: sourceSha, assets: [] },
  {
    tag_name: 'mem-preview-20261015-current', published_at: '2026-10-15T10:00:00Z', draft: false,
    target_commitish: sourceSha,
    assets: [
      { name: 'opencode-linux-x64.tar.gz', digest: `sha256:${archiveSha256}` },
      { name: 'opencode-linux-x64.tar.gz.sha256', digest: null },
    ],
  },
  { tag_name: 'mem-v20261016-stable', published_at: '2026-10-16T11:00:00Z', draft: false, target_commitish: 'd'.repeat(40), assets: [] },
];

describe('OpenCode release freshness guard', () => {
  it('selects the newest published preview, ignoring drafts and stable releases', () => {
    expect(latestOpenCodePreview([releases.slice(0, 2), releases.slice(2)]).tag_name).toBe('mem-preview-20261015-current');
  });

  it('accepts the exact newest tag, source commit and archive digest', () => {
    expect(assertOpenCodeReleaseFreshness(releases, {
      releaseTag: 'mem-preview-20261015-current', sourceSha, archiveSha256,
    })).toEqual({ tag: 'mem-preview-20261015-current', sourceSha, archiveSha256 });
  });

  it('fails the worker build when the pinned OpenCode preview is stale', () => {
    expect(() => assertOpenCodeReleaseFreshness(releases, {
      releaseTag: 'mem-preview-20261014-old', sourceSha: 'c'.repeat(40), archiveSha256,
    })).toThrow('Pinned OpenCode release is stale');
  });

  it('fails if the tag, archive digest or required Linux assets do not match the pin', () => {
    expect(() => assertOpenCodeReleaseFreshness(releases, {
      releaseTag: 'mem-preview-20261015-current', sourceSha: 'c'.repeat(40), archiveSha256,
    })).toThrow('source SHA does not match');
    expect(() => assertOpenCodeReleaseFreshness(releases, {
      releaseTag: 'mem-preview-20261015-current', sourceSha, archiveSha256: 'f'.repeat(64),
    })).toThrow('archive SHA-256 does not match');
    expect(() => assertOpenCodeReleaseFreshness([{ ...releases[2], assets: [] }], {
      releaseTag: 'mem-preview-20261015-current', sourceSha, archiveSha256,
    })).toThrow('missing the Linux archive or checksum asset');
  });
});
