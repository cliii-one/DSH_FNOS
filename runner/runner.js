/**
 * DSH - 飞牛 fnOS 统一网关桥接器 (Gateway Bridge)
 *
 * 为什么存在：
 *   DSH 官方 web 服务只会监听 TCP 端口（127.0.0.1:3081），
 *   而飞牛"统一网关"要求应用在 TRIM_APPDEST 下创建一个 Unix Socket（dsh.sock），
 *   由飞牛 nginx 完成登录鉴权后转发请求过来。
 *   本桥接器就是两者之间的转换层：Unix Socket 收请求 -> 转发给本机 dsh web。
 *
 * 与"裸端口方案"相比的优势（采用官方推荐架构的原因）：
 *   1. 不占用任何对外端口 —— 彻底避免端口冲突
 *   2. 必须先登录飞牛 NAS 才能访问 DSH —— 不再向局域网裸暴露服务
 *   3. WebSocket / 用户身份 Header 由网关原生透传
 *
 * 职责：
 *   1. 启动 dsh web（仅 127.0.0.1，外部无法直连）
 *   2. 在 TRIM_APPDEST/dsh.sock 创建 HTTP 服务并转发
 *   3. 注入 crypto.randomUUID polyfill（DSH 前端在部分环境需要）
 *   4. SIGTERM 时优雅回收子进程与 socket 文件
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'data');

// dsh web 只监听本机回环，外部设备无法绕过网关直连
const DSH_PORT = parseInt(process.env.DSH_PORT || '3083', 10);
const SOCKET_PATH = path.join(APP_DIR, process.env.GATEWAY_SOCKET || 'dsh.sock');

// 飞牛统一网关转发时会保留原始路径前缀 /app/{appname}（gatewayPrefix），
// 而 dsh web 按根路径 / 提供服务，不认识该前缀（返回 404 Not Found）。
// 转发前把前缀剥离，响应中的绝对路径引用也在响应层改写回来。
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '/app/dsh';

// /app/dsh/xxx -> /xxx；/app/dsh -> /
function stripGatewayPrefix(urlPath) {
    if (urlPath === GATEWAY_PREFIX) return '/';
    if (urlPath.startsWith(GATEWAY_PREFIX + '/')) return urlPath.slice(GATEWAY_PREFIX.length);
    return urlPath;
}

// 响应体里的绝对引用 /xxx 改回 /app/dsh/xxx，让浏览器后续请求仍走网关
// 仅处理 HTML/JS/CSS 文本，且避免二次改写（//开头是协议相对地址，跳过）
function restoreGatewayPrefix(text) {
    if (!text) return text;
    const P = GATEWAY_PREFIX;
    return text
        .replace(/(src|href|action)=(["'])\/(?!\/)/g, `$1=$2${P}/`)
        .replace(/(url\(\s*)(["']?)\/(?!\/)/g, `$1$2${P}/`)
        .replace(/(["'])\/(assets|api|ws)\b/g, `$1${P}/$2`);
}

// 回退端口模式（DSH_FALLBACK_PORT=1 时启用）：额外监听 0.0.0.0:PORT 对局域网服务。
// 仅在用户显式关闭统一网关时使用，默认走更安全的网关模式。
const FALLBACK_ENABLED = process.env.DSH_FALLBACK_PORT === '1';
const FALLBACK_PORT = parseInt(process.env.PORT || '3082', 10);

const NODE_BIN = process.env.DSH_NODE_BIN || 'node';
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// umask 0：DSH 创建的文件对 NAS 用户/SMB 完全可读写
try { process.umask(0); } catch (e) {}

function startDsh() {
    // 启动前预置 browser-session 凭据：dsh 启动时读取 .credentials.yaml，
    // 桥接器据此自签认证 cookie（无需 token/303 流程）
    ensureBrowserSessionSecret();

    const dsh = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--no-open'], {
        // HOME 继承 cmd/main 设置的值（@appshare/dsh），.dsh 落在共享目录
        env: { ...process.env },
        cwd: VAR_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    dsh.on('exit', (code) => {
        console.log(`[Bridge] dsh web exited (${code}), bridge exits too`);
        process.exit(code === null ? 1 : code);
    });

    return dsh;
}

// ---------- 第二步：Unix Socket HTTP 服务 ----------

// 注入 polyfill：修复部分浏览器在特定上下文缺少 crypto.randomUUID 的问题
const POLYFILL = ';if(typeof crypto!=="undefined"&&!crypto.randomUUID){crypto.randomUUID=function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(Math.random()*0x3|0x8);return v.toString(16);});}};';

// ---------- 认证：自签 browser-session cookie ----------
//
// 原理（参考 deepseek-harness-fpk 社区实现并实测验证）：
// dsh 的浏览器认证 cookie 由 .dsh/.credentials.yaml 中
// client-connection/browser-session 的 secret 以 HMAC-SHA256 签发，
// cookie 名 = "dsh-auth-" + base64url(sha256(authority))。
// 桥接器预置该 secret 后即可自行签发有效 cookie，
// 无需 token / 303 重定向流程（此前 Not Found 的根源）。

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeBase64Url(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

// 确保 credentials.yaml 中存在 browser-session secret（无则生成并预置）
// 路径规则与 dsh 一致：$DSH_HOME/.credentials.yaml（DSH_HOME 即 .dsh 目录本身），
// 未设置时回退 $HOME/.dsh
function resolveDshHomeDir() {
    const explicit = process.env.DSH_HOME;
    if (explicit && explicit.trim().length > 0) return explicit;
    return path.join(process.env.HOME || VAR_DIR, '.dsh');
}

function ensureBrowserSessionSecret() {
    const credPath = path.join(resolveDshHomeDir(), '.credentials.yaml');
    const secretVar = 'client-connection/browser-session';
    try {
        if (fs.existsSync(credPath)) {
            const content = fs.readFileSync(credPath, 'utf-8');
            const m = content.match(new RegExp(secretVar.replace('/', '\\/') + ':[^\\n]*\\n\\s*kind:\\s*grant\\s*\\n\\s*payload:\\s*\\n\\s*version:\\s*1\\s*\\n\\s*secret:\\s*([A-Za-z0-9_-]+)'));
            if (m) return decodeBase64Url(m[1]);
        }
        // 生成新 secret 并写入
        const secret = crypto.randomBytes(32);
        const secretStr = encodeBase64Url(secret);
        const record = `records:\n  ${secretVar}:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secretStr}\n`;
        fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(credPath)) {
            let content = fs.readFileSync(credPath, 'utf-8');
            if (/^records:\s*$/m.test(content)) {
                content = content.replace(/^records:\s*$/m, `records:\n  ${secretVar}:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secretStr}`);
                fs.writeFileSync(credPath, content, { mode: 0o600 });
            } else {
                fs.appendFileSync(credPath, `\n${record}`, { mode: 0o600 });
            }
        } else {
            fs.writeFileSync(credPath, `version: 1\n${record}`, { mode: 0o600 });
        }
        console.log('[Bridge] 已预置 browser-session 认证密钥');
        return secret;
    } catch (e) {
        console.warn('[Bridge] 预置认证密钥失败:', e.message);
        return null;
    }
}

// 用预置 secret 自签认证 cookie（缓存 12 小时）
let cachedAuthCookie = null;
let lastCookieGenTime = 0;
function getAuthCookie() {
    const now = Date.now();
    if (cachedAuthCookie && now - lastCookieGenTime < 12 * 3600 * 1000) return cachedAuthCookie;
    const secret = ensureBrowserSessionSecret();
    if (!secret) return '';
    const authority = `127.0.0.1:${DSH_PORT}`;
    const cookieName = 'dsh-auth-' + encodeBase64Url(crypto.createHash('sha256').update(authority).digest());
    const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 24 * 3600 * 1000 };
    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = crypto.createHmac('sha256', secret).update(body).digest();
    cachedAuthCookie = `${cookieName}=${body ? `v1.${body}.${encodeBase64Url(sig)}` : ''}`;
    lastCookieGenTime = now;
    return cachedAuthCookie;
}

// 请求转发头：合并用户 cookie 与自签 cookie，对齐 Origin/Referer 防 CSRF 403
function buildUpstreamHeaders(req) {
    const authCookie = getAuthCookie();
    const incomingCookie = req.headers['cookie'] || '';
    const merged = authCookie
        ? (incomingCookie ? `${incomingCookie}; ${authCookie}` : authCookie)
        : incomingCookie;
    const headers = {
        ...req.headers,
        // 经飞牛统一网关（Unix socket）进来的请求没有 remoteAddress，
        // 直接透传 undefined 会让 Node 抛 ERR_HTTP_INVALID_HEADER_VALUE
        'x-forwarded-for': req.socket.remoteAddress || '127.0.0.1',
        'x-forwarded-proto': 'http',
        'x-forwarded-host': req.headers.host || `127.0.0.1:${DSH_PORT}`,
        host: `127.0.0.1:${DSH_PORT}`,
        cookie: merged,
    };
    // 清理任何值为 undefined/null 的头，避免同类异常
    for (const key of Object.keys(headers)) {
        if (headers[key] === undefined || headers[key] === null) delete headers[key];
    }
    if (req.headers.origin) headers.origin = `http://127.0.0.1:${DSH_PORT}`;
    if (req.headers.referer) headers.referer = `http://127.0.0.1:${DSH_PORT}/`;
    if (headers['sec-fetch-site'] === 'cross-site') headers['sec-fetch-site'] = 'same-origin';
    // 文本类请求关压缩，便于统一改写
    if (req.url === '/' || !req.url.includes('.')) delete headers['accept-encoding'];
    return headers;
}

// ---------- 请求转发（自签 cookie 认证） ----------

function proxyRequest(req, res) {
    // 剥离网关前缀：/app/dsh/xxx -> /xxx（dsh 按根路径服务）
    const reqPath = stripGatewayPrefix(req.url);
    const headers = buildUpstreamHeaders(req);

    const upstream = http.request({
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: reqPath,
        method: req.method,
        headers,
    }, (upRes) => {
        // dsh 下发的 set-cookie 已由自签 cookie 覆盖认证，不透传给浏览器
        const outHeaders = { ...upRes.headers };
        delete outHeaders['set-cookie'];
        const ct = upRes.headers['content-type'] || '';
        const shouldRewrite = ct.includes('text/html') || ct.includes('javascript') || ct.includes('css');
        if (!shouldRewrite) {
            res.writeHead(upRes.statusCode, outHeaders);
            upRes.pipe(res);
            return;
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
            let body = Buffer.concat(chunks.map(Buffer.from)).toString('utf-8');
            body = restoreGatewayPrefix(body) + POLYFILL;
            const out = Buffer.from(body, 'utf-8');
            outHeaders['content-length'] = out.length;
            delete outHeaders['content-encoding'];
            delete outHeaders['transfer-encoding'];
            res.writeHead(upRes.statusCode, outHeaders);
            res.end(out);
        });
    });
    req.pipe(upstream);
    upstream.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('DSH 尚未就绪，请稍后刷新重试\n');
    });
}

// ---------- 网关前缀剥离与回写 ----------
// ---------- 回退端口模式：局域网 TCP 监听（仅网关关闭时启用） ----------

function startFallbackProxy() {
    const server = http.createServer(proxyRequest);

    // WebSocket 升级：直接透传
    server.on('upgrade', (req, socket, head) => {
        const upUrl = stripGatewayPrefix(req.url);
        const upstream = net.connect(DSH_PORT, '127.0.0.1', () => {
            // 复制浏览器原始头，但 Cookie 由桥接器接管（认证代理）
            const lines = [`${req.method} ${upUrl} HTTP/1.1`];
            let hasCookie = false;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i];
                const lname = name.toLowerCase();
                if (lname === 'cookie') { hasCookie = true; continue; } // 稍后统一注入
                if (lname === 'host') continue; // host 由 CONNECT 目标决定
                lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
            }
            if (getAuthCookie()) lines.push(`Cookie: ${getAuthCookie()}`);
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => { try { socket.destroy(); } catch (e) {} });
        socket.on('error', () => { try { upstream.destroy(); } catch (e) {} });
    });

    return new Promise((resolve, reject) => {
        server.listen(FALLBACK_PORT, '0.0.0.0', () => {
            console.log(`[Bridge] fallback LAN proxy on 0.0.0.0:${FALLBACK_PORT} -> 127.0.0.1:${DSH_PORT}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

function startBridge() {
    // 重建 socket 文件，避免残留旧文件导致 listen 失败
    fs.rmSync(SOCKET_PATH, { force: true });

    const server = http.createServer(proxyRequest);

    // WebSocket 升级请求：透传到 dsh web
    server.on('upgrade', (req, socket, head) => {
        const upUrl = stripGatewayPrefix(req.url);
        // Cookie 由桥接器接管：丢弃浏览器 cookie，注入桥接器持有的会话 cookie
        const upHeaders = { ...req.headers, host: `127.0.0.1:${DSH_PORT}` };
        if (getAuthCookie()) upHeaders.cookie = getAuthCookie();
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: DSH_PORT,
            path: upUrl,
            method: req.method,
            headers: upHeaders,
        });
        upstream.on('upgrade', (upRes, upSocket, upHead) => {
            const lines = [`HTTP/1.1 101 Switching Protocols`];
            for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
            socket.write(lines.join('\r\n') + '\r\n\r\n');
            if (upHead && upHead.length) socket.write(upHead);
            upSocket.pipe(socket);
            socket.pipe(upSocket);
            const cleanup = () => { try { upSocket.destroy(); socket.destroy(); } catch (e) {} };
            upSocket.on('error', cleanup);
            socket.on('error', cleanup);
        });
        upstream.on('error', () => { try { socket.destroy(); } catch (e) {} });
        upstream.end();
    });

    return new Promise((resolve, reject) => {
        server.listen(SOCKET_PATH, () => {
            console.log(`[Bridge] gateway socket ready: ${SOCKET_PATH} -> 127.0.0.1:${DSH_PORT}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

// ---------- 第三步：优雅退出 ----------

function shutdown(signal, dshChild, server) {
    console.log(`[Bridge] received ${signal}, shutting down`);
    if (server) { try { server.close(); } catch (e) {} }
    fs.rmSync(SOCKET_PATH, { force: true });
    if (dshChild && dshChild.exitCode === null) {
        try { dshChild.kill('SIGTERM'); } catch (e) {}
    }
    // 给子进程 3 秒宽限，超时由 cmd/main 兜底强杀
    setTimeout(() => process.exit(0), 3000).unref();
}

// ---------- 启动 ----------

async function main() {
    if (!fs.existsSync(DSH_BIN)) {
        console.error(`[Bridge] FATAL: dsh bin not found at ${DSH_BIN}`);
        process.exit(1);
    }
    fs.mkdirSync(VAR_DIR, { recursive: true });

    const dshChild = startDsh();
    let server = null;
    process.on('SIGTERM', () => shutdown('SIGTERM', dshChild, server));
    process.on('SIGINT', () => shutdown('SIGINT', dshChild, server));

    try {
        server = await startBridge();
        if (FALLBACK_ENABLED) {
            server = await startFallbackProxy();
        }
    } catch (e) {
        console.error('[Bridge] FATAL: listen failed:', e.message);
        dshChild.kill('SIGTERM');
        process.exit(1);
    }
    console.log(`[Bridge] started (app=${APP_DIR}, var=${VAR_DIR}, fallback=${FALLBACK_ENABLED})`);
}

main();
