#!/usr/bin/env node
// Проба границы — отдельный .mjs-скрипт, который Runner спавнит под идентичностью рана,
// поэтому tsc его не копирует: копируем вручную рядом с dist/isolation/clean-room.js.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(repo, 'src', 'isolation', 'probe', 'boundary-probe.mjs');
const targetDir = join(repo, 'dist', 'isolation', 'probe');
mkdirSync(targetDir, { recursive: true });
cpSync(source, join(targetDir, 'boundary-probe.mjs'));
process.stdout.write(`isolation probe copied: ${source} -> ${targetDir}\n`);
