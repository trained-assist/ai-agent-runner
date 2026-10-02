// Клиент unix-socket моста рана для дочерних процессов (MCP-сервер, broker).
// Значения credential binding'ов по мосту не передаются: наружу уходят только
// capabilityId и аргументы, binding и caller подставляет хост.
import { connect } from 'node:net';

export class BridgeClient {
  #socket = null;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;

  constructor({ url, runToken, serverId, onLog }) {
    this.url = url;
    this.runToken = runToken;
    this.serverId = serverId ?? '';
    this.onLog = onLog ?? (() => undefined);
  }

  get socketPath() {
    if (!this.url.startsWith('unix://')) throw new Error(`unsupported bridge url: ${this.url}`);
    return this.url.slice('unix://'.length);
  }

  async open() {
    const socketPath = this.socketPath;
    const socket = connect(socketPath);
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.#buffer.slice(0, index).replace(/\r$/, '');
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim().length > 0) this.#onLine(line);
        index = this.#buffer.indexOf('\n');
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const hello = await this.request('hello', { runToken: this.runToken });
    if (hello.ok !== true) throw new Error(`bridge hello rejected: ${JSON.stringify(hello)}`);
    this.onLog({ level: 'info', event: 'bridge_connected', serverId: this.serverId, pid: hello.pid });
    return hello;
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onLog({ level: 'warn', event: 'bridge_non_json', line: line.slice(0, 200) });
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  request(op, payload = {}, timeoutMs = 30000) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('bridge socket is not connected'));
    const requestId = `r${this.#nextId}`;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`bridge op "${op}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ requestId, op, ...payload })}\n`);
    });
  }

  close() {
    if (this.#socket && !this.#socket.destroyed) this.#socket.destroy();
    this.#socket = null;
  }
}
