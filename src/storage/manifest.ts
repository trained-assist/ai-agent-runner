import { ErrorCollector, checkKeys, checkObject, checkString, isSafeId, isUtcTimestamp, type ValidationResult } from '../contracts/validate.js';
import { StorageError } from './errors.js';
import { assertSafeStorageKey, runArtifactKey } from './keys.js';

export const ARTIFACT_MANIFEST_KEYS = [
  'artifactId',
  'runId',
  'userTaskId',
  'profileId',
  'name',
  'mime',
  'size',
  'sha256',
  'storageKey',
  'createdAt',
] as const;

export interface ArtifactManifest {
  artifactId: string;
  runId: string;
  userTaskId: string;
  profileId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdAt: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const FILE_NAME_RE = /^[^/\\]+$/;

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

export function validateArtifactManifest(input: unknown): ValidationResult<ArtifactManifest> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'artifactManifest', collector)) return collector.finish(undefined as never);
  checkKeys(input, ARTIFACT_MANIFEST_KEYS, ARTIFACT_MANIFEST_KEYS, 'artifactManifest', collector);

  const artifactId = input['artifactId'];
  const runId = input['runId'];
  if (!isSafeId(artifactId)) collector.push('artifactManifest.artifactId: expected id');
  if (!isSafeId(runId)) collector.push('artifactManifest.runId: expected id');
  checkString(input['userTaskId'], 'artifactManifest.userTaskId', collector, 200);
  checkString(input['profileId'], 'artifactManifest.profileId', collector, 200);
  checkString(input['name'], 'artifactManifest.name', collector, 200);
  checkString(input['mime'], 'artifactManifest.mime', collector, 100);
  checkString(input['storageKey'], 'artifactManifest.storageKey', collector, 500);
  checkString(input['sha256'], 'artifactManifest.sha256', collector, 64);
  checkString(input['createdAt'], 'artifactManifest.createdAt', collector, 40);

  const name = input['name'];
  if (typeof name === 'string' && name.length > 0 && !FILE_NAME_RE.test(name)) {
    collector.push('artifactManifest.name: a file name must not contain path separators');
  }
  const mime = input['mime'];
  if (typeof mime === 'string' && mime.length > 0 && !MIME_RE.test(mime)) {
    collector.push('artifactManifest.mime: expected type/subtype');
  }
  const sha256 = input['sha256'];
  if (typeof sha256 === 'string' && sha256.length > 0 && !isSha256(sha256)) {
    collector.push('artifactManifest.sha256: expected 64 lowercase hex chars');
  }
  const size = input['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    collector.push('artifactManifest.size: expected non-negative integer');
  }
  if (!isUtcTimestamp(input['createdAt'])) collector.push('artifactManifest.createdAt: expected UTC ISO timestamp');

  const storageKey = input['storageKey'];
  if (typeof storageKey === 'string' && storageKey.length > 0) {
    try {
      assertSafeStorageKey(storageKey);
    } catch {
      collector.push('artifactManifest.storageKey: expected a safe relative storage key');
    }
    if (isSafeId(artifactId) && isSafeId(runId)) {
      const expected = runArtifactKey(runId, artifactId);
      if (storageKey !== expected) collector.push(`artifactManifest.storageKey: expected ${expected}`);
    }
  }

  return collector.finish(input as unknown as ArtifactManifest);
}

export function parseArtifactManifest(raw: string, source: string): ArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError('ARTIFACT_MANIFEST_INVALID', `artifact manifest is not valid JSON: ${source}`);
  }
  const validated = validateArtifactManifest(parsed);
  if (!validated.ok) {
    throw new StorageError('ARTIFACT_MANIFEST_INVALID', `artifact manifest is invalid in ${source}: ${validated.errors.join('; ')}`);
  }
  return validated.value;
}
