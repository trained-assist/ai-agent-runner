import { readFile } from 'node:fs/promises';

/**
 * Выбор кандидата на промоушен из релизов форка `gpt-mem/opencode-mem`.
 *
 * Хук продвижения должен отвечать на один вопрос: «появилась ли сборка форка,
 * которой у нас ещё нет, и можно ли её вообще рассматривать». Поэтому модуль
 * намеренно не скачивает и не запускает бинарь — он только отбирает релиз и
 * отказывает на всём, что нельзя проверить: черновик, prerelease, тег не того
 * формата, отсутствующий SHA источника, отсутствующий дайджест архива.
 *
 * Сравнение идёт по commit'у, а не по тегу: два тега могут указывать на один
 * коммит, а один коммит — пересобираться. Отдельно ловится откат: если
 * активная сборка выпущена позже кандидата (например, откатились на старый
 * релиз), промоушен не запускается.
 */

export const FORK_REPO = 'gpt-mem/opencode-mem';

const PREVIEW_TAG = /^mem-preview-(\d{8})-[A-Za-z0-9.-]+$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const LINUX_ARCHIVE = 'opencode-linux-x64.tar.gz';
const LINUX_CHECKSUM = `${LINUX_ARCHIVE}.sha256`;

/**
 * Опубликованные mem-preview релизы, старые первыми. Черновики не рассматриваются.
 *
 * Флаг GitHub `prerelease` здесь НЕ фильтруется: форк помечает свои preview-релизы
 * как prerelease, и отбрасывая их, детектор не видит ровно те релизы, которые пиннит
 * `vm-worker-release.yml`. Тег и так говорит «preview», а проверяемость релиза
 * (SHA источника, дайджест архива) проверяется ниже по отдельности.
 */
export function publishedForkReleases(releases) {
  return releases.flat(Infinity)
    .filter((release) => release && !release.draft
      && PREVIEW_TAG.test(release.tag_name ?? '')
      && Number.isFinite(Date.parse(release.published_at ?? '')))
    .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
}

/**
 * Приводит релиз к проверяемому виду. `version` и `binarySha256` здесь нет
 * специально: их нельзя узнать из метаданных релиза — только из самого бинаря,
 * поэтому их снимает гейт после скачивания.
 */
export function forkReleaseIdentity(release) {
  const tag = release?.tag_name ?? '';
  const match = PREVIEW_TAG.exec(tag);
  if (!match) throw new Error(`Not a mem-preview fork release: ${tag || '(missing tag)'}`);
  const sourceCommit = release?.target_commitish ?? '';
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new Error(`Fork release ${tag} does not pin a full source commit: ${sourceCommit || '(missing)'}`);
  }
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const archive = assets.find((asset) => asset?.name === LINUX_ARCHIVE);
  const checksum = assets.find((asset) => asset?.name === LINUX_CHECKSUM);
  if (!archive || !checksum) {
    throw new Error(`Fork release ${tag} is missing ${LINUX_ARCHIVE} or its checksum`);
  }
  const archiveSha256 = String(archive.digest ?? '').replace(/^sha256:/, '');
  if (!SHA256.test(archiveSha256)) {
    throw new Error(`Fork release ${tag} does not publish a sha256 digest for ${LINUX_ARCHIVE}`);
  }
  return { tag, date: match[1], sourceCommit, archiveSha256, publishedAt: release.published_at };
}

/**
 * `active` — то, что реально обслуживает сейчас: `{ sourceCommit, tag? }`.
 * Возвращает `status`:
 *   `candidate`  — есть более свежая сборка с другим коммитом, её надо проверить;
 *   `up-to-date` — кандидата нет, промоушен не нужен;
 *   `downgrade`  — последний опубликованный релиз старше активного: не трогаем.
 */
export function selectPromotionCandidate(releases, active) {
  const activeCommit = active?.sourceCommit ?? '';
  if (!SOURCE_COMMIT.test(activeCommit)) {
    throw new Error('Active OpenCode source commit must be a full 40-character Git SHA');
  }
  const published = publishedForkReleases(releases);
  if (published.length === 0) throw new Error('No published mem-preview OpenCode release was found');
  const candidate = forkReleaseIdentity(published.at(-1));

  if (candidate.sourceCommit === activeCommit) {
    return { status: 'up-to-date', candidate, active: { sourceCommit: activeCommit, tag: active?.tag ?? null }, reason: `Latest fork release ${candidate.tag} is the active build` };
  }

  const activeDate = PREVIEW_TAG.exec(active?.tag ?? '')?.[1];
  if (activeDate && candidate.date < activeDate) {
    return { status: 'downgrade', candidate, active: { sourceCommit: activeCommit, tag: active.tag }, reason: `Active build ${active.tag} is newer than the latest published release ${candidate.tag}; refusing to roll back without an explicit decision` };
  }

  return { status: 'candidate', candidate, active: { sourceCommit: activeCommit, tag: active?.tag ?? null }, reason: `Fork release ${candidate.tag} (${candidate.sourceCommit}) differs from the active build ${activeCommit}` };
}

const invokedDirectly = process.argv[1]?.endsWith('opencode-promotion-candidate.mjs');
if (invokedDirectly) {
  const [releasesPath, activeSourceSha, activeTag] = process.argv.slice(2);
  if (!releasesPath || !activeSourceSha) {
    throw new Error('Usage: opencode-promotion-candidate.mjs <releases.json> <active-source-sha> [<active-release-tag>]');
  }
  const decision = selectPromotionCandidate(
    JSON.parse(await readFile(releasesPath, 'utf8')),
    { sourceCommit: activeSourceSha, tag: activeTag },
  );
  const lines = [
    `status=${decision.status}`,
    `candidate_tag=${decision.candidate.tag}`,
    `candidate_source_commit=${decision.candidate.sourceCommit}`,
    `candidate_archive_sha256=${decision.candidate.archiveSha256}`,
    `candidate_date=${decision.candidate.date}`,
  ];
  const text = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_OUTPUT) await (await import('node:fs/promises')).appendFile(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
  process.stdout.write(`${decision.status}: ${decision.reason}\n`);
}
