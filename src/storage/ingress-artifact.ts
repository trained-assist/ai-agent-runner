import { createHmac } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { IngressManifestRef } from '../contracts/run-spec.js';
import { isSafeId, PreflightError } from '../contracts/validate.js';
import { isSafeRelativePath } from './local-paths.js';
import { sha256Hex } from './blob-store.js';

export interface IngressArtifact {
  contractVersion: 1;
  ref: string;
  version: string;
  ownerProfileId: string;
  mediaType: string;
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface IngressInputItem {
  text?: string;
  artifacts: IngressArtifact[];
}

export interface IngressManifest {
  manifestRef: string;
  manifestVersion: string;
  contractVersion: 1;
  userTaskId: string;
  profileId: string;
  inputItems: IngressInputItem[];
}

export interface IngressArtifactBytes {
  bytes: Uint8Array;
  ref: string | null;
  version: string | null;
  ownerProfileId: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export interface IngressArtifactResolver {
  getManifest(userTaskId: string): Promise<unknown>;
  getArtifact(taskId: string, pin: IngressManifestRef, artifact: IngressArtifact): Promise<IngressArtifactBytes>;
}

const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export class ControlPlaneIngressResolver implements IngressArtifactResolver {
  private readonly baseUrl: URL;

  constructor(
    private readonly options: { baseUrl: string; principalId: string; secret: string; fetcher?: typeof fetch; timeoutMs?: number },
  ) {
    let parsed: URL;
    try { parsed = new URL(options.baseUrl); } catch { throw new Error('invalid Control Plane URL'); }
    const localHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Control Plane URL must be HTTPS and contain no credentials, query, or fragment');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.principalId) || !options.secret) throw new Error('Control Plane principal credentials are required');
    this.baseUrl = parsed;
  }

  private async request(path: string): Promise<Response> {
    const signature = createHmac('sha256', this.options.secret).update(this.options.principalId, 'utf8').digest('hex');
    try {
      return await (this.options.fetcher ?? fetch)(new URL(path, this.baseUrl), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        headers: { 'x-principal': this.options.principalId, 'x-principal-sig': signature },
      });
    } catch {
      throw unavailable('Control Plane ingress request failed');
    }
  }

  async getManifest(userTaskId: string): Promise<unknown> {
    const url = new URL('/runner/input-manifest', this.baseUrl);
    url.searchParams.set('taskId', userTaskId);
    const response = await this.request(url.toString());
    if (!response.ok) throw responseError(response.status);
    let text: string;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw invalid('Control Plane manifest response has no body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024) {
          await reader.cancel();
          throw invalid('ingress manifest exceeds size limit');
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks, total).toString('utf8');
    } catch (error) {
      if (error instanceof PreflightError) throw error;
      throw unavailable('Control Plane manifest read failed');
    }
    try { return JSON.parse(text) as unknown; } catch { throw invalid('Control Plane returned invalid manifest JSON'); }
  }

  async getArtifact(taskId: string, pin: IngressManifestRef, artifact: IngressArtifact): Promise<IngressArtifactBytes> {
    const url = new URL('/runner/input-artifact', this.baseUrl);
    for (const [key, value] of Object.entries({ taskId, manifestRef: pin.manifestRef, manifestVersion: pin.manifestVersion, ref: artifact.ref, version: artifact.version })) {
      url.searchParams.set(key, value);
    }
    const response = await this.request(url.toString());
    if (!response.ok) throw responseError(response.status);
    const length = response.headers.get('content-length');
    if (length === null || !/^\d+$/.test(length) || Number(length) > MAX_ARTIFACT_BYTES) throw invalid('artifact response has invalid content length');
    let bytes: Uint8Array;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw invalid('artifact response has no body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARTIFACT_BYTES || total > Number(length)) {
          await reader.cancel();
          throw invalid('artifact response exceeds its declared size');
        }
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks, total);
      if (total !== Number(length)) throw invalid('artifact response is shorter than its declared size');
    } catch (error) {
      if (error instanceof PreflightError) throw error;
      throw unavailable('Control Plane artifact stream failed');
    }
    const artifactSize = response.headers.get('x-artifact-size-bytes');
    if (artifactSize === null || !/^\d+$/.test(artifactSize)) throw invalid('artifact response has invalid artifact size metadata');
    return {
      bytes,
      ref: response.headers.get('x-artifact-ref'),
      version: response.headers.get('x-artifact-version'),
      ownerProfileId: response.headers.get('x-artifact-owner-profile-id'),
      mediaType: response.headers.get('content-type'),
      sizeBytes: Number(artifactSize),
      sha256: response.headers.get('x-artifact-sha256'),
    };
  }
}

export function createControlPlaneIngressResolverFromEnv(env: Record<string, string | undefined> = process.env): ControlPlaneIngressResolver | undefined {
  const baseUrl = env['RUNNER_CONTROL_PLANE_URL']?.trim();
  const principalId = env['RUNNER_CONTROL_PLANE_PRINCIPAL']?.trim();
  const secret = env['RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET'];
  if (!baseUrl && !principalId && !secret) return undefined;
  if (!baseUrl || !principalId || !secret) throw new Error('RUNNER_CONTROL_PLANE_URL, RUNNER_CONTROL_PLANE_PRINCIPAL and RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET must be configured together');
  return new ControlPlaneIngressResolver({ baseUrl, principalId, secret });
}

export async function materializeIngressManifest(
  resolver: IngressArtifactResolver,
  pin: IngressManifestRef,
  target: { runId: string; userTaskId: string; profileId: string; ownerGeneration: number; cwd: string },
): Promise<{ files: number; bytes: number; artifactCount: number; artifacts: Array<{ ref: string; bytes: number }> }> {
  if (pin.userTaskId !== target.userTaskId || pin.profileId !== target.profileId || pin.runId !== target.runId || pin.ownerGeneration !== target.ownerGeneration) {
    throw invalid('ingress manifest pin is bound to a different task, profile, run, or generation');
  }
  const raw = await resolver.getManifest(target.userTaskId);
  const manifest = validateManifest(raw, pin, target);
  const artifacts = manifest.inputItems.flatMap((item) => item.artifacts);
  if (artifacts.length > MAX_ARTIFACTS) throw invalid('ingress manifest exceeds artifact count limit');
  let declaredTotal = 0;
  for (const artifact of artifacts) {
    if (artifact.sizeBytes > MAX_ARTIFACT_BYTES) throw invalid('ingress artifact exceeds per-file size limit');
    declaredTotal += artifact.sizeBytes;
  }
  const textBytes = manifest.inputItems.reduce((sum, item) => sum + Buffer.byteLength(item.text ?? ''), 0);
  if (textBytes > MAX_TEXT_BYTES || declaredTotal + textBytes > MAX_TOTAL_BYTES) throw invalid('ingress manifest exceeds total input size limit');

  const fetched = new Map<string, Buffer>();
  const materializedContentBytes = textBytes + declaredTotal;
  for (const artifact of artifacts) {
    const key = `${artifact.ref}\u0000${artifact.version}`;
    let bytes = fetched.get(key);
    if (!bytes) {
      let result: IngressArtifactBytes;
      try { result = await resolver.getArtifact(target.userTaskId, pin, artifact); }
      catch (error) { throw normalizeResolverError(error); }
      validateArtifactResponse(result, artifact, target.profileId);
      bytes = Buffer.from(result.bytes);
      fetched.set(key, bytes);
    } else {
      validateDuplicate(artifacts, artifact);
    }
  }

  const outputDir = join(target.cwd, '.inputs', 'ingress', target.runId);
  const stagingDir = join(target.cwd, '.inputs', `.staging-ingress-${target.runId}`);
  ensureContainedDirectories(target.cwd, ['.inputs', '.inputs/ingress']);
  if (pathExists(stagingDir)) throw invalid('ingress staging path already exists');
  mkdirSync(stagingDir, { mode: 0o700 });
  try {
    const writtenItems: Array<{ text?: string; artifacts: Array<{ ref: string; version: string; path: string; mediaType: string }> }> = [];
    let fileIndex = 0;
    for (const item of manifest.inputItems) {
      const written: { text?: string; artifacts: Array<{ ref: string; version: string; path: string; mediaType: string }> } = { artifacts: [] };
      if (item.text !== undefined) written.text = item.text;
      for (const artifact of item.artifacts) {
        const basename = safeName(artifact.name);
        const relativePath = `${fileIndex.toString().padStart(2, '0')}-${basename}`;
        if (!isSafeRelativePath(relativePath)) throw invalid('generated ingress artifact path is unsafe');
        writeFileSync(join(stagingDir, relativePath), fetched.get(`${artifact.ref}\u0000${artifact.version}`) as Buffer, { flag: 'wx', mode: 0o600 });
        written.artifacts.push({ ref: artifact.ref, version: artifact.version, path: relativePath, mediaType: artifact.mediaType });
        fileIndex += 1;
      }
      writtenItems.push(written);
    }
    const index = Buffer.from(JSON.stringify({ contractVersion: 1, inputItems: writtenItems }, null, 2));
    writeFileSync(join(stagingDir, 'input-items.json'), index, { flag: 'wx', mode: 0o600 });
    const actualTotal = materializedContentBytes + index.length;
    if (actualTotal > MAX_TOTAL_BYTES) throw invalid('materialized ingress input exceeds total size limit');
    mkdirSync(join(target.cwd, '.inputs', 'ingress'), { recursive: true });
    renameSync(stagingDir, outputDir);
    return { files: artifacts.length + 1, bytes: actualTotal, artifactCount: artifacts.length, artifacts: artifacts.map((artifact) => ({ ref: artifact.ref, bytes: artifact.sizeBytes })) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function validateManifest(raw: unknown, pin: IngressManifestRef, target: { userTaskId: string; profileId: string; runId: string; ownerGeneration: number }): IngressManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Control Plane returned an invalid ingress manifest');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['manifestRef', 'manifestVersion', 'contractVersion', 'userTaskId', 'profileId', 'inputItems'].includes(key))) throw invalid('ingress manifest contains unknown fields');
  if (pin.manifestRef !== `cp-input-manifest:${target.userTaskId}` || value['contractVersion'] !== 1 || value['manifestRef'] !== pin.manifestRef || value['manifestVersion'] !== pin.manifestVersion || value['userTaskId'] !== target.userTaskId || value['profileId'] !== target.profileId || !Array.isArray(value['inputItems'])) {
    throw invalid('ingress manifest does not match its task, profile, or pinned version');
  }
  const items: IngressInputItem[] = [];
  for (const rawItem of value['inputItems']) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw invalid('ingress manifest contains an invalid input item');
    const item = rawItem as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== 'text' && key !== 'artifacts')) throw invalid('ingress manifest input item contains unknown fields');
    if (item['text'] !== undefined && (typeof item['text'] !== 'string' || Buffer.byteLength(item['text']) > MAX_TEXT_BYTES)) throw invalid('ingress manifest contains invalid text');
    if (item['artifacts'] !== undefined && !Array.isArray(item['artifacts'])) throw invalid('ingress manifest contains invalid artifact list');
    items.push({ ...(item['text'] === undefined ? {} : { text: item['text'] as string }), artifacts: (item['artifacts'] as unknown[] | undefined ?? []).map(parseArtifact) });
  }
  const canonical = JSON.stringify({ contractVersion: 1, userTaskId: target.userTaskId, profileId: target.profileId, inputItems: items.map((item) => ({ ...(item.text === undefined ? {} : { text: item.text }), artifacts: item.artifacts })) });
  if (sha256Hex(canonical) !== pin.manifestVersion) throw invalid('ingress manifest content does not match its pinned sha256');
  return { manifestRef: pin.manifestRef, manifestVersion: pin.manifestVersion, contractVersion: 1, userTaskId: target.userTaskId, profileId: target.profileId, inputItems: items };
}

function parseArtifact(value: unknown): IngressArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('ingress manifest contains an invalid artifact');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['contractVersion', 'ref', 'version', 'ownerProfileId', 'mediaType', 'name', 'sizeBytes', 'sha256'].includes(key))) throw invalid('ingress artifact contains unknown fields');
  if (item['contractVersion'] !== 1 || !isSafeId(item['ref']) || item['ref'].length > 500 || typeof item['version'] !== 'string' || !item['version'] || item['version'].length > 500 || /[\x00-\x1f]/.test(item['version']) || typeof item['ownerProfileId'] !== 'string' || typeof item['mediaType'] !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(item['mediaType']) || typeof item['name'] !== 'string' || !item['name'] || item['name'].length > 255 || typeof item['sizeBytes'] !== 'number' || !Number.isSafeInteger(item['sizeBytes']) || item['sizeBytes'] < 0 || typeof item['sha256'] !== 'string' || !SHA256.test(item['sha256'])) throw invalid('ingress manifest contains invalid artifact metadata');
  return item as unknown as IngressArtifact;
}

function validateArtifactResponse(result: IngressArtifactBytes, artifact: IngressArtifact, profileId: string): void {
  const bytes = Buffer.from(result.bytes);
  if (result.ref !== artifact.ref || result.version !== artifact.version || result.ownerProfileId !== profileId || artifact.ownerProfileId !== profileId || result.mediaType?.split(';')[0]?.trim().toLowerCase() !== artifact.mediaType.toLowerCase() || result.sizeBytes !== artifact.sizeBytes || result.sha256 !== artifact.sha256 || bytes.length !== artifact.sizeBytes || sha256Hex(bytes) !== artifact.sha256) {
    throw invalid('ingress artifact metadata or bytes do not match the pinned manifest');
  }
}

function validateDuplicate(all: IngressArtifact[], artifact: IngressArtifact): void {
  const matches = all.filter((entry) => entry.ref === artifact.ref && entry.version === artifact.version);
  if (matches.some((entry) => JSON.stringify(entry) !== JSON.stringify(artifact))) throw invalid('duplicate ingress ref has conflicting metadata');
}

function safeName(name: string): string {
  const basename = name.split(/[\\/]/).pop() ?? 'artifact';
  const cleaned = basename.normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'artifact.bin';
}

function ensureContainedDirectories(root: string, directories: string[]): void {
  const rootPath = resolve(root);
  const rootReal = realpathSync(rootPath);
  for (const directory of directories) {
    const target = join(rootPath, ...directory.split('/'));
    if (!pathExists(target)) mkdirSync(target, { mode: 0o700 });
    const stats = lstatSync(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw invalid('ingress workspace directory is not a real directory');
    const targetReal = realpathSync(target);
    const inside = relative(rootReal, targetReal);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw invalid('ingress workspace directory escapes the run root');
  }
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function responseError(status: number): PreflightError {
  if (status === 408 || status === 429 || status >= 500) return unavailable(`Control Plane ingress returned HTTP ${status}`);
  return invalid(`Control Plane ingress rejected the request (HTTP ${status})`);
}

function unavailable(message: string): PreflightError { return new PreflightError('INGRESS_INPUT_UNAVAILABLE', message, { retryable: true }); }
function invalid(message: string): PreflightError { return new PreflightError('INGRESS_INPUT_INVALID', message, { retryable: false }); }

function normalizeResolverError(error: unknown): PreflightError {
  return error instanceof PreflightError ? error : unavailable('Control Plane ingress transport failed');
}
