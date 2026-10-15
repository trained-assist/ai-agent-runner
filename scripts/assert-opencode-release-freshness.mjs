import { readFile } from 'node:fs/promises';

const PREVIEW_TAG = /^mem-preview-\d{8}-.+$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function latestOpenCodePreview(releases) {
  const candidates = releases.flat(Infinity)
    .filter((release) => release && !release.draft && PREVIEW_TAG.test(release.tag_name ?? '')
      && Number.isFinite(Date.parse(release.published_at ?? '')))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
  if (candidates.length === 0) throw new Error('No published mem-preview OpenCode release was found');
  return candidates.at(-1);
}

export function assertOpenCodeReleaseFreshness(releases, pin) {
  const latest = latestOpenCodePreview(releases);
  if (latest.tag_name !== pin.releaseTag) {
    throw new Error(`Pinned OpenCode release is stale: pinned=${pin.releaseTag}, latest=${latest.tag_name}; update the worker release pin and hashes`);
  }
  if (!SOURCE_SHA.test(pin.sourceSha ?? '') || latest.target_commitish !== pin.sourceSha) {
    throw new Error(`Pinned OpenCode source SHA does not match ${latest.tag_name}: expected=${latest.target_commitish}, pinned=${pin.sourceSha}`);
  }
  if (!SHA256.test(pin.archiveSha256 ?? '')) throw new Error('Pinned OpenCode archive SHA-256 is invalid');

  const archive = latest.assets?.find((asset) => asset.name === 'opencode-linux-x64.tar.gz');
  const checksum = latest.assets?.find((asset) => asset.name === 'opencode-linux-x64.tar.gz.sha256');
  if (!archive || !checksum) throw new Error(`Latest OpenCode release ${latest.tag_name} is missing the Linux archive or checksum asset`);
  if (archive.digest && archive.digest !== `sha256:${pin.archiveSha256}`) {
    throw new Error(`Pinned OpenCode archive SHA-256 does not match ${latest.tag_name}: expected=${archive.digest}, pinned=${pin.archiveSha256}`);
  }
  return { tag: latest.tag_name, sourceSha: pin.sourceSha, archiveSha256: pin.archiveSha256 };
}

if (process.argv[1]?.endsWith('assert-opencode-release-freshness.mjs')) {
  const [metadataPath, releaseTag, sourceSha, archiveSha256] = process.argv.slice(2);
  if (!metadataPath || !releaseTag || !sourceSha || !archiveSha256) {
    throw new Error('Usage: assert-opencode-release-freshness.mjs <release-metadata.json> <release-tag> <source-sha> <archive-sha256>');
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const pin = assertOpenCodeReleaseFreshness(metadata, { releaseTag, sourceSha, archiveSha256 });
  process.stdout.write(`OpenCode release pin is current: ${pin.tag} source=${pin.sourceSha} archiveSha256=${pin.archiveSha256}\n`);
}
