import { appendFile, readFile } from 'node:fs/promises';
import { parseWorkerReleaseIdentity } from './opencode-release-identity.mjs';

const [buildInfoPath, releaseTag] = process.argv.slice(2);
if (!buildInfoPath || !releaseTag) throw new Error('usage: write-worker-release-identity.mjs <build-info.json> <release-tag>');
const identity = parseWorkerReleaseIdentity(JSON.parse(await readFile(buildInfoPath, 'utf8')), releaseTag);
const output = {
  worker_release_tag: identity.releaseTag,
  worker_release_version: identity.workerVersion,
  worker_release_source_commit: identity.workerSourceCommit,
  opencode_version: identity.opencodeVersion,
  opencode_source_commit: identity.opencodeSourceCommit,
  opencode_binary_sha256: identity.opencodeBinarySha256,
};
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `${Object.entries(output).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
} else {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
