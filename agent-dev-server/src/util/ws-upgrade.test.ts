import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net, { type Socket } from 'node:net';
import { describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { acceptUpgrade, upgradePathname, upgradeSearchParams } from './ws-upgrade.ts';

const INVALID_UTF8_TEXT_FRAME = Buffer.from([0x81, 0x81, 0x00, 0x00, 0x00, 0x00, 0xff]);
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');

interface RawUpgradeResponse {
  socket: Socket;
  status: number;
}

function rawUpgrade(
  port: number,
  options: { path?: string; host?: string } = {},
): Promise<RawUpgradeResponse> {
  const path = options.path ?? '/ws';
  const host = options.host ?? `127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = Buffer.alloc(0);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onClose = (): void => fail(new Error('socket closed before an HTTP response'));
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf(HEADER_TERMINATOR);
      if (end === -1) {
        return;
      }
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('error', fail);
      socket.off('data', onData);
      socket.pause();
      const rest = response.subarray(end + HEADER_TERMINATOR.length);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      const statusLine = response.subarray(0, response.indexOf('\r\n')).toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
      if (!match) {
        fail(new Error(`invalid HTTP response: ${statusLine}`));
        return;
      }
      resolve({ socket, status: Number(match[1]) });
    };
    const timer = setTimeout(() => fail(new Error('upgrade response timed out')), 1_000);
    socket.once('close', onClose);
    socket.once('error', fail);
    socket.on('data', onData);
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });
  });
}

function serverClosed(socket: Socket, deadlineMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      socket.off('close', onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), deadlineMs);
    socket.once('close', onClose);
    socket.resume();
  });
}

interface CloseFrame {
  code: number;
  reason: string;
}

function readCloseFrame(socket: Socket, deadlineMs = 1_000): Promise<CloseFrame | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const finish = (frame: CloseFrame | null): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(frame);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2 || buffered[0] !== 0x88) {
        return;
      }
      const length = buffered[1] ?? 0;
      if (buffered.length < 2 + length) {
        return;
      }
      finish({
        code: length >= 2 ? buffered.readUInt16BE(2) : 0,
        reason: buffered.subarray(4, 2 + length).toString('utf8'),
      });
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    socket.on('data', onData);
    socket.resume();
  });
}

async function uncaughtDuring(body: () => Promise<void>): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const capture = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on('uncaughtException', capture);
  try {
    await body();
  } finally {
    process.off('uncaughtException', capture);
  }
  return uncaught;
}

async function startServer(
  onConnection: (ws: WebSocket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (upgradePathname(req) !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    acceptUpgrade(wss, { req, socket, head }, 'test', onConnection);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server must bind a TCP port');
  return {
    port: address.port,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
    },
  };
}

describe('acceptUpgrade', () => {
  it('contains a protocol error after a service refuses the connection', async () => {
    const server = await startServer((ws) => ws.close(4001, 'Authentication required'));
    try {
      let closed = false;
      const uncaught = await uncaughtDuring(async () => {
        const response = await rawUpgrade(server.port);
        assert.strictEqual(response.status, 101);
        response.socket.write(INVALID_UTF8_TEXT_FRAME);
        closed = await serverClosed(response.socket);
        response.socket.destroy();
      });
      assert.deepStrictEqual(uncaught, []);
      assert.strictEqual(closed, true);
    } finally {
      await server.close();
    }
  });

  it('contains a synchronous connection-handler failure', async () => {
    const server = await startServer(() => {
      throw new Error('handoff failed');
    });
    try {
      let closeFrame: CloseFrame | null = null;
      const uncaught = await uncaughtDuring(async () => {
        const response = await rawUpgrade(server.port);
        assert.strictEqual(response.status, 101);
        closeFrame = await readCloseFrame(response.socket);
        response.socket.destroy();
      });
      assert.deepStrictEqual(uncaught, []);
      assert.deepStrictEqual(closeFrame, { code: 1011, reason: 'Internal error' });
    } finally {
      await server.close();
    }
  });
});

describe('request-target parsing', () => {
  it('routes and reads the query from an ordinary target', () => {
    const req = { url: '/voice?agent_session_id=s1' };
    assert.strictEqual(upgradePathname(req), '/voice');
    assert.strictEqual(upgradeSearchParams(req).get('agent_session_id'), 's1');
  });

  it('returns an empty result for a malformed target', () => {
    const req = { url: '//[' };
    assert.strictEqual(upgradePathname(req), null);
    assert.strictEqual(upgradeSearchParams(req).get('agent_session_id'), null);
  });

  it('does not use Host when parsing the request target', async () => {
    const server = await startServer((ws) => ws.close(1000, 'done'));
    try {
      const uncaught = await uncaughtDuring(async () => {
        const response = await rawUpgrade(server.port, { host: '[' });
        assert.strictEqual(response.status, 101);
        response.socket.destroy();
      });
      assert.deepStrictEqual(uncaught, []);
    } finally {
      await server.close();
    }
  });

  it('rejects a malformed request target without throwing', async () => {
    const server = await startServer((ws) => ws.close(1000, 'done'));
    try {
      const uncaught = await uncaughtDuring(async () => {
        const response = await rawUpgrade(server.port, { path: '//[' });
        assert.strictEqual(response.status, 400);
        response.socket.destroy();
      });
      assert.deepStrictEqual(uncaught, []);
    } finally {
      await server.close();
    }
  });
});

describe('runtime endpoint wiring', () => {
  for (const file of ['websocket-handler.ts', 'voice-gateway.ts']) {
    it(`${file} accepts sockets through the guarded helper`, async () => {
      const source = await readFile(new URL(`../ws/${file}`, import.meta.url), 'utf8');
      assert.match(source, /acceptUpgrade\(/);
      assert.doesNotMatch(source, /new URL\(req\.url/);

      if (file === 'websocket-handler.ts') {
        assert.doesNotMatch(source, /wss\.handleUpgrade\(/);
      } else {
        assert.doesNotMatch(source, /#wss\.handleUpgrade\(/);
      }
    });
  }
});
