import type { ProfileWorkspaceSpec } from '../contracts/run-spec.js';

/**
 * The profile workspace of the Cloudflare Runner API lane.
 *
 * The lane owns the profile: it serves the base a run starts from and receives
 * the bytes the run publishes. The request cannot choose either — a caller that
 * could name a snapshot URL or a saveback URL would turn the lane into a fetcher
 * for the caller's own host. The host mints the capability, pins the base by
 * digest and hands the worker URLs on the lane's own origin.
 */

/**
 * An empty gzip-compressed tar: this lane's profile has no content to restore
 * yet, so the base a run starts from is an empty archive. The bytes are a
 * constant, so the digest below is the digest of exactly what the lane serves —
 * the worker verifies the pin before it extracts anything.
 */
const EMPTY_PROFILE_SNAPSHOT_BASE64 = 'H4sIAAAAAAAC/+3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAIA3A5reHScAKAAA';
export const EMPTY_PROFILE_SNAPSHOT_SIZE = 45;
export const EMPTY_PROFILE_SNAPSHOT_SHA256 = '272adeccafe73e7009d51f2ec2be9871db5e0eb14239f483ea429be26c3c6402';

/**
 * The published bytes the lane keeps per run. The lane is a proof lane, not an
 * archive: a file is kept in one storage value, and a Durable Object value
 * (key and value together) may not exceed 2 MB, so a published file is capped
 * well below that. A larger publication is refused, not silently truncated.
 */
export const MAX_PROFILE_FILE_BYTES = 1024 * 1024;
export const MAX_PROFILE_RUN_BYTES = 8 * 1024 * 1024;

/** A one-run, write-only capability: it may publish to this run's saveback and nothing else. */
export function mintSavebackToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function emptyProfileSnapshotBytes(): Uint8Array {
  const binary = atob(EMPTY_PROFILE_SNAPSHOT_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function profileSnapshotUrl(publicUrl: string, runId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/v1/worker/launches/${encodeURIComponent(runId)}/profile-snapshot`;
}

export function profileChangesUrl(publicUrl: string, runId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/v1/worker/launches/${encodeURIComponent(runId)}/profile-changes`;
}

/**
 * The pinned base of the lane's profile.
 *
 * The saveback path clones nothing: the base of a run is the snapshot, and the
 * snapshot is pinned by its digest and size. The runner still asks every profile
 * workspace for a pinned base, so the launch carries the snapshot's digest in
 * that field — a content pin of the base that actually exists, not a git commit
 * the lane never checked out.
 */
export function profileBaseRevision(): string {
  return EMPTY_PROFILE_SNAPSHOT_SHA256.slice(0, 40);
}

export function buildProfileWorkspaceSpec(args: { runId: string; publicUrl: string; token: string }): ProfileWorkspaceSpec {
  return {
    bindingId: 'cloudflare-lane-profile',
    snapshotUrl: profileSnapshotUrl(args.publicUrl, args.runId),
    snapshotSha256: EMPTY_PROFILE_SNAPSHOT_SHA256,
    snapshotSize: EMPTY_PROFILE_SNAPSHOT_SIZE,
    savebackUrl: profileChangesUrl(args.publicUrl, args.runId),
    savebackToken: args.token,
    artifacts: [],
    excludedPatterns: [],
  };
}

/** A published path is a relative path inside the profile: no absolute root, no "..", no control characters. */
export function isSafeProfilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The key the lane keeps one published file under. */
export function profileBytesKey(runId: string, path: string): string {
  return `profile-bytes:${runId}:${path}`;
}
