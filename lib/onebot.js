/**
 * OneBot v11 传输层：一条消息两条腿。
 *
 * - 收：正向 WebSocket（NapCat「WebSocket 服务器」）或 HTTP 上报（插件自己监听端口）。
 * - 发：WebSocket 打开时直接走 WS；否则走 HTTP API（NapCat「HTTP 服务器」）。
 *
 * 两个方向都不引入第三方依赖：WS 用 Node 内置 WebSocket（Node ≥ 22），
 * HTTP 用 node:http + 全局 fetch。所有定时器都 unref()，不会拖住宿主进程退出。
 *
 * @module dsh-qq/onebot
 */
import http from 'node:http';

/** 单个 API 调用的超时。 */
const REQUEST_TIMEOUT_MS = 25_000;
/** HTTP 上报正文上限，防止误配置把宿主内存打满。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** WS 无任何帧超过该时间就认为连接已死（OneBot 心跳通常 5s 一次）。 */
const WS_IDLE_MS = 90_000;

/** 不拖住宿主进程的 sleep。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 校验上报请求携带的 token。
 * OneBot 各实现会放在 Authorization、access_token 查询参数或 token 头里。
 * @param request - 入站 HTTP 请求。
 * @param token - 配置的 token；空串表示不校验。
 * @returns 是否放行。
 */
function authorized(request, token) {
  if (token === '') return true;
  const header = String(request.headers.authorization ?? '');
  if (header === token) return true;
  if (header === `Bearer ${token}` || header === `Token ${token}`) return true;
  if (String(request.headers['x-self-id'] ?? '') !== '' && String(request.headers.token ?? '') === token) return true;
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    return url.searchParams.get('access_token') === token;
  } catch {
    return false;
  }
}

/**
 * OneBot v11 客户端：负责连接、重连、事件分发与 API 调用。
 */
export class OneBotClient {
  /**
   * @param options - 配置读取函数、日志、事件回调与状态回调。
   */
  constructor(options) {
    this.options = options;
    this.getConfig = options.getConfig;
    this.logger = options.logger;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus ?? (() => {});

    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map();
    this.echo = 0;
    this.stopped = true;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.httpListening = false;
    this.lastError = '';
    this.lastFrameAt = 0;
    this.connectedAt = 0;
    this.selfId = '';
    this.signature = '';
    this.mode = 'idle';
    this.watchdog = null;
  }

  /** 当前配置（每次现读，设置页改了立刻生效）。 */
  get config() {
    return this.getConfig();
  }

  /** 启动传输并在之后跟随配置变化。 */
  start() {
    this.stopped = false;
    this.apply();
    if (this.watchdog === null) {
      this.watchdog = setInterval(() => this.sync(), 5_000);
      this.watchdog.unref?.();
    }
  }

  /** 停止一切：WS、HTTP 监听、重连与未决请求。 */
  stop() {
    this.stopped = true;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.teardown();
  }

  /** 配置指纹：连接参数一变就重建传输。 */
  computeSignature() {
    const cfg = this.config;
    return JSON.stringify([
      cfg.enabled,
      cfg.transport,
      cfg.onebotWsUrl,
      cfg.onebotHttpApi,
      cfg.onebotToken,
      cfg.eventHost,
      cfg.eventPort,
    ]);
  }

  /** 定时对账：配置变了就重建，断线久了就重连。 */
  sync() {
    if (this.stopped) return;
    const cfg = this.config;
    if (cfg.enabled === false) {
      if (this.mode !== 'idle') this.teardown();
      return;
    }
    const signature = this.computeSignature();
    if (signature !== this.signature) {
      this.signature = signature;
      this.apply();
      return;
    }
    const wantedWs = this.wantsWs(cfg);
    if (wantedWs && this.ws === null && this.reconnectTimer === null) this.connectWs();
    if (this.ws !== null && this.ws.readyState === 1 && this.lastFrameAt > 0 && Date.now() - this.lastFrameAt > WS_IDLE_MS) {
      this.logger.warn('dsh-qq: WebSocket 长时间没有数据，主动重连');
      this.dropWs('stale');
    }
  }

  /** 是否应该走 WebSocket。 */
  wantsWs(cfg) {
    if (cfg.transport === 'http') return false;
    return String(cfg.onebotWsUrl ?? '').trim() !== '';
  }

  /** 按当前配置（重新）建立传输。 */
  apply() {
    this.teardown();
    const cfg = this.config;
    if (cfg.enabled === false) {
      this.mode = 'idle';
      this.onStatus();
      return;
    }
    this.signature = this.computeSignature();
    if (this.wantsWs(cfg)) this.connectWs();
    if (cfg.transport !== 'ws') this.startServer(cfg);
    if (!this.wantsWs(cfg) && cfg.transport === 'ws') {
      this.lastError = '配置为只用 WebSocket，但 onebotWsUrl 为空';
      this.onStatus();
    }
    if (this.mode === 'idle' && this.httpListening) this.mode = 'http';
    this.onStatus();
  }

  /** 拆掉 WS 与 HTTP 监听，并让未决调用失败。 */
  teardown() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.dropWs('teardown');
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      this.httpListening = false;
      try {
        server.close();
      } catch {
        /* 端口可能已关闭 */
      }
    }
    for (const [echo, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`OneBot 调用已取消（${echo}）`));
    }
    this.pending.clear();
    this.mode = 'idle';
    this.lastError = '';
  }

  /** 主动断开 WebSocket（重连由 scheduleReconnect 决定）。 */
  dropWs(reason) {
    const socket = this.ws;
    if (socket === null) return;
    this.ws = null;
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
    if (reason === 'stale' || reason === 'error') this.scheduleReconnect();
  }

  /** 指数退避重连。 */
  scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) return;
    if (!this.wantsWs(this.config)) return;
    this.attempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || !this.wantsWs(this.config)) return;
      this.connectWs();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** 建立正向 WebSocket 连接。 */
  connectWs() {
    const cfg = this.config;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (typeof globalThis.WebSocket !== 'function') {
      this.lastError = '当前运行时没有 WebSocket，只能用 HTTP 上报模式';
      this.logger.warn('dsh-qq: globalThis.WebSocket 不可用');
      this.onStatus();
      return;
    }
    let url = String(cfg.onebotWsUrl ?? '').trim();
    if (!/^wss?:\/\//i.test(url)) {
      this.lastError = `onebotWsUrl 不是 ws:// 地址：${url}`;
      this.onStatus();
      return;
    }
    if (String(cfg.onebotToken ?? '') !== '') {
      url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(String(cfg.onebotToken))}`;
    }
    let socket;
    try {
      socket = new globalThis.WebSocket(url);
    } catch (error) {
      this.lastError = `WebSocket 创建失败：${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(`dsh-qq: ${this.lastError}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.mode = 'ws';
    this.lastFrameAt = Date.now();
    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.lastFrameAt = Date.now();
      this.lastError = '';
      this.mode = 'ws';
      this.logger.info('dsh-qq: OneBot WebSocket 已连接');
      this.onStatus();
    });
    socket.addEventListener('message', (event) => {
      if (this.ws !== socket) return;
      this.lastFrameAt = Date.now();
      void this.consumeFrame(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.ws !== socket) return;
      this.lastError = 'OneBot WebSocket 连接失败（检查地址、端口与 token）';
      this.onStatus();
    });
    socket.addEventListener('close', () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.mode = this.httpListening ? 'http' : 'idle';
      this.logger.warn('dsh-qq: OneBot WebSocket 断开');
      this.onStatus();
      this.scheduleReconnect();
    });
    this.onStatus();
  }

  /** 解析一帧 WS 数据：事件或 API 响应。 */
  async consumeFrame(data) {
    let text;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    else if (typeof data?.text === 'function') text = await data.text();
    else return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (payload !== null && typeof payload === 'object' && payload.post_type !== undefined) {
      this.accept(payload);
      return;
    }
    if (payload !== null && typeof payload === 'object' && payload.echo !== undefined) {
      const entry = this.pending.get(String(payload.echo));
      if (entry === undefined) return;
      this.pending.delete(String(payload.echo));
      clearTimeout(entry.timer);
      if (payload.retcode === 0 || payload.status === 'ok') entry.resolve(payload.data ?? payload);
      else entry.reject(new Error(`OneBot ${payload.retcode ?? '?'}: ${payload.message ?? payload.wording ?? '调用失败'}`));
    }
  }

  /** 把一条 OneBot 事件交给桥接层。 */
  accept(event) {
    if (event === null || typeof event !== 'object') return;
    if (event.self_id !== undefined) this.noteSelfId(String(event.self_id));
    try {
      this.onEvent(event);
    } catch (error) {
      this.logger.error(`dsh-qq: 处理事件失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 记住机器人自己的 QQ 号。 */
  noteSelfId(id) {
    if (id === '' || id === 'undefined') return;
    if (this.selfId === id) return;
    this.selfId = id;
    this.onStatus();
  }

  /** 启动 HTTP 上报监听。 */
  startServer(cfg) {
    const host = String(cfg.eventHost ?? '127.0.0.1').trim() || '127.0.0.1';
    const port = Math.max(1, Math.min(65_535, Number(cfg.eventPort) || 5701));
    const token = String(cfg.onebotToken ?? '');
    const server = http.createServer((request, response) => {
      void this.handleHttp(request, response, token);
    });
    server.on('error', (error) => {
      this.httpListening = false;
      this.lastError = `HTTP 上报端口 ${port} 不可用：${error.message}`;
      this.logger.warn(`dsh-qq: ${this.lastError}`);
      this.onStatus();
    });
    server.on('listening', () => {
      this.httpListening = true;
      this.connectedAt = Date.now();
      if (this.mode === 'idle') this.mode = 'http';
      this.logger.info(`dsh-qq: HTTP 上报监听 http://${host}:${port}/`);
      this.onStatus();
    });
    try {
      server.listen(port, host);
    } catch (error) {
      this.lastError = `HTTP 上报监听失败：${error instanceof Error ? error.message : String(error)}`;
      this.logger.warn(`dsh-qq: ${this.lastError}`);
    }
    this.server = server;
  }

  /** 处理一次 HTTP 上报（也支持 GET 探活）。 */
  async handleHttp(request, response, token) {
    if (this.options.handleAdmin !== undefined) {
      let pathname = '';
      try {
        pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        pathname = '';
      }
      // 插件自带配置页挂在上报端口上，和 OneBot 上报共用同一个监听。
      if (pathname === '/admin' || pathname === '/admin/config') {
        try {
          this.options.handleAdmin(request, response);
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(this.status()));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (!authorized(request, token)) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('unauthorized');
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('bad json');
        return;
      }
      response.writeHead(204);
      response.end();
      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) this.accept(event);
    });
  }

  /** 通过 WS（优先）或 HTTP API 调用一个 OneBot 动作。 */
  async call(action, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const cfg = this.config;
    const socket = this.ws;
    if (socket !== null && socket.readyState === 1) {
      try {
        return await this.wsCall(socket, action, params, timeoutMs);
      } catch (error) {
        if (String(cfg.onebotHttpApi ?? '').trim() === '') throw error;
        this.logger.warn(`dsh-qq: WS 调用 ${action} 失败，改走 HTTP：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const api = String(cfg.onebotHttpApi ?? '').trim();
    if (api === '') throw new Error('QQ 未连接：WebSocket 未打开，也没有可用的 HTTP API 地址');
    return this.httpCall(api, action, params, timeoutMs);
  }

  /** 在 WS 上发一次动作调用并等待 echo 响应。 */
  wsCall(socket, action, params, timeoutMs) {
    const echo = `${Date.now().toString(36)}-${(this.echo += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  /** 用 HTTP API 发一次动作调用。 */
  async httpCall(api, action, params, timeoutMs) {
    const token = String(this.config.onebotToken ?? '');
    const headers = { 'content-type': 'application/json' };
    if (token !== '') headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${api.replace(/\/+$/, '')}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(`OneBot HTTP ${response.status}：${text.slice(0, 200)}`);
    if (payload !== null && (payload.status === 'failed' || (typeof payload.retcode === 'number' && payload.retcode !== 0))) {
      throw new Error(`OneBot ${action} 失败：${payload.message ?? payload.wording ?? text.slice(0, 200)}`);
    }
    return payload?.data ?? payload;
  }

  /** 当前状态快照（给工具与调试输出用）。 */
  status() {
    const cfg = this.config;
    const socket = this.ws;
    return {
      enabled: cfg.enabled !== false,
      transport: cfg.transport,
      wsUrl: cfg.onebotWsUrl,
      httpApi: cfg.onebotHttpApi,
      eventPort: cfg.eventPort,
      mode: this.mode,
      wsOpen: socket !== null && socket.readyState === 1,
      httpListening: this.httpListening,
      selfId: this.selfId || String(cfg.selfId ?? ''),
      connectedAt: this.connectedAt,
      lastFrameAt: this.lastFrameAt,
      lastError: this.lastError,
    };
  }

  /** 是否至少有一条腿是通的。 */
  get online() {
    return this.httpListening || (this.ws !== null && this.ws.readyState === 1);
  }
}

export { sleep };
