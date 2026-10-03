import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, waitFor } from './helpers.js';
import { RecordingLauncher, StubCleanRoomProvider, logMessages } from './isolation-helpers.js';
import { ENGINE_CONFIG_LAYOUTS, loadEngineConfigTemplates, materializeEngineConfig } from '../src/isolation/engine-config.js';
import { FakeEngine } from '../src/adapters/engine/fake-engine.js';
import { CleanRoomError, type CleanRoom } from '../src/isolation/contract.js';

const layout = ENGINE_CONFIG_LAYOUTS['opencode'] as { dir: string; file: string };

/**
 * Ран с именем движка `opencode`: шаблон кладётся по имени движка, поэтому подменить
 * нужно именно его. Движок здесь — управляемый fake (реальный бинарь есть только на VM2),
 * аутентичность процесса всё равно проверяет лаунчер рана.
 */
const opencodeSpec = { engine: { name: 'opencode', adapterVersion: '1' } };
function opencodeHarness(options: { templatesDir?: string; scenario?: 'success' | 'timeout' } = {}) {
  const launcher = new RecordingLauncher();
  let provider!: StubCleanRoomProvider;
  const h = createHarness({
    scenario: options.scenario ?? 'success',
    adapters: { fake: new FakeEngine(options.scenario ?? 'success'), opencode: new FakeEngine(options.scenario ?? 'success') },
    isolation: (rootDir: string) => {
      provider = new StubCleanRoomProvider({ rootDir }, launcher);
      return provider;
    },
    ...(options.templatesDir === undefined
      ? {}
      : { engineConfigTemplates: loadEngineConfigTemplates(options.templatesDir) }),
  });
  return { h, launcher, provider: () => provider };
}

/**
 * Конфиг движка внутри run-scoped HOME (issue #51, блокер приёмки #23): своя HOME рана
 * убирает у движка конфиг пользователя сервиса, поэтому provider/model кладёт хост.
 * Проверяем ровно три вещи: копия доезжает в XDG_CONFIG_HOME с правами слота, хостовый
 * шаблон остаётся нетронутым read-only активом, а сломанный шаблон валит ран ДО спавна
 * движка (иначе движок ушёл бы на платный профиль по умолчанию молча).
 */
describe('конфиг движка в run-scoped clean room', () => {
  it('хостовый шаблон копируется в XDG_CONFIG_HOME рана, 0600, и не меняет сам шаблон', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'engine-config-templates-'));
    const template = { model: 'openrouter/qwen/qwen3.8-27b:free' };
    const templatePath = join(templatesDir, 'opencode.json');
    writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o444 });

    const loaded = loadEngineConfigTemplates(templatesDir);
    expect(loaded?.engines).toEqual(['opencode']);

    const { h, launcher, provider } = opencodeHarness({ templatesDir, scenario: 'timeout' });

    const { receipt } = h.start(opencodeSpec);
    // Ран «висящий» (scenario=timeout): каталоги среды на месте, пока их не снёс sweep.
    await waitFor(() => logMessages(h.rootDir, receipt.runId).some((line) => line.startsWith('engine_config.seeded')));

    const configDir = join(h.rootDir, 'cleanrooms', receipt.runId, 'config', layout.dir);
    const configPath = join(configDir, layout.file);
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(template);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    // Каталог конфигурации — тоже часть среды рана: 0700, иначе движок под идентичностью
    // рана не прочитает свой конфиг и уйдёт на модель по умолчанию (проверено на VM2).
    expect(statSync(configDir).mode & 0o777).toBe(0o700);

    // В лог рана попадает sha256 копии, а не её содержимое.
    const seeded = logMessages(h.rootDir, receipt.runId).find((line) => line.startsWith('engine_config.seeded')) as string;
    const expected = createHash('sha256').update(readFileSync(configPath, 'utf8')).digest('hex');
    expect(seeded).toContain(`sha256=${expected}`);
    expect(seeded).not.toContain('qwen');

    // Хостовый шаблон не переписан: он остаётся отдельным активом на 0444.
    expect(JSON.parse(readFileSync(templatePath, 'utf8'))).toEqual(template);
    expect(statSync(templatePath).mode & 0o777).toBe(0o444);

    // Копия уезжает вместе со средой: после отмены и sweep каталогов рана нет.
    await h.runner.cancel(receipt.runId, 1);
    await waitFor(() => provider().freeSlots().length === 2);
    expect(existsSync(configPath)).toBe(false);
  });

  it('сломанный шаблон валит ран ДО спавна движка, а не оставляет движок без модели', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'engine-config-broken-'));
    writeFileSync(join(templatesDir, 'opencode.json'), '{ this is not json');

    const { h, launcher } = opencodeHarness({ templatesDir });

    const { receipt } = h.start(opencodeSpec);
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(launcher.calls).toHaveLength(0);
    // Причина отказа — в результате рана (фаза границы), а не в молчаливом логе.
    expect(result.failure?.code).toBe('ENGINE_CONFIG_INVALID');
    expect(result.failure?.safeSummary).toContain('not valid JSON');
    expect(result.outputRefs).toEqual([]);
  });

  it('шаблон для незнакомого движка — отказ хоста, а не молчаливый пропуск', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'engine-config-unknown-'));
    writeFileSync(join(templatesDir, 'claude.json'), '{"model":"x"}');
    const loaded = loadEngineConfigTemplates(templatesDir);
    expect(loaded?.engines).toEqual(['claude']);

    const root = mkdtempSync(join(tmpdir(), 'engine-config-room-'));
    const room = {
      runId: 'run_probe',
      identity: { slotId: 'slot-a', username: 'slot-a', uid: 40001, gid: 40001 },
      paths: {
        root,
        cwd: join(root, 'w'),
        home: join(root, 'home'),
        config: join(root, 'config'),
        cache: join(root, 'cache'),
        data: join(root, 'data'),
        tmp: join(root, 'tmp'),
        mcp: join(root, 'mcp'),
      },
      env: {},
      probe: null,
      acl: 'posix_0700',
    } as unknown as CleanRoom;
    expect(() => materializeEngineConfig(loaded, room, 'claude')).toThrow(CleanRoomError);
  });

  it('без объявленного каталога поведение прежнее: копии нет, ран идёт как обычно', async () => {
    expect(loadEngineConfigTemplates(undefined)).toBeNull();
    expect(loadEngineConfigTemplates('')).toBeNull();
    expect(loadEngineConfigTemplates(join(tmpdir(), 'engine-config-absent-' + process.pid))).toBeNull();

    const { h, launcher } = opencodeHarness();
    const { receipt, spec } = h.start(opencodeSpec);
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(launcher.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(h.rootDir, 'cleanrooms', receipt.runId, 'config', layout.dir))).toBe(false);
    expect(existsSync(spec.cwd)).toBe(false);
  });

  it('каталог шаблонов без файла движка: ран не падает, копии нет', async () => {
    const templatesDir = mkdtempSync(join(tmpdir(), 'engine-config-other-'));
    writeFileSync(join(templatesDir, 'opencode.json'), '{"model":"openrouter/qwen/qwen3.8-27b:free"}');

    // Движок fake: для него хоста шаблона нет, и это не поломка настройки.
    const { h } = opencodeHarness();
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    const configRoot = join(h.rootDir, 'cleanrooms', receipt.runId, 'config');
    expect(logMessages(h.rootDir, receipt.runId).some((line) => line.startsWith('engine_config.seeded'))).toBe(false);
    expect(existsSync(configRoot)).toBe(false);
  });

});
