#!/usr/bin/env node
// Фикстуры MCP — это .mjs-скрипты, которые runner спавнит как дочерние процессы, поэтому
// tsc их не копирует: копируем вручную рядом с dist/mcp/session.js.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(repo, 'src', 'mcp', 'fixtures');
const target = join(repo, 'dist', 'mcp', 'fixtures');
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
process.stdout.write(`mcp fixtures copied: ${source} -> ${target}\n`);
