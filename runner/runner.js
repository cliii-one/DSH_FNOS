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
    // dsh web 启动时会打印一次性访问 token（http://127.0.0.1:PORT/?token=xxx），
    // 网关过来的请求没有这个 token 会被 DSH 拒绝（Not Found）。
    // 这里接管 stdout，捕获 token 供转发时自动附加
    const dsh = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--no-open'], {
        // HOME 继承 cmd/main 设置的值（@appshare/dsh），.dsh 落在共享目录
        env: { ...process.env },
        cwd: VAR_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collectToken = (chunk) => {
        const text = chunk.toString();
        process.stdout.write('[dsh] ' + text);
        const m = text.match(/token=([A-Za-z0-9_-]+)/);
        if (m && !process.env.DSH_AUTH_TOKEN) {
            process.env.DSH_AUTH_TOKEN = m[1];
            console.log('[Bridge] 已捕获 dsh 访问 token，转发请求将自动携带');
        }
    };
    dsh.stdout.on('data', collectToken);
    dsh.stderr.on('data', collectToken);

    dsh.on('exit', (code) => {
        console.log(`[Bridge] dsh web exited (${code}), bridge exits too`);
        process.exit(code === null ? 1 : code);
    });

    return dsh;
}

// ---------- 第二步：Unix Socket HTTP 服务 ----------

// 注入 polyfill：修复部分浏览器在特定上下文缺少 crypto.randomUUID 的问题
const POLYFILL = ';if(typeof crypto!=="undefined"&&!crypto.randomUUID){crypto.randomUUID=function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(Math.random()*0x3|0x8);return v.toString(16);});}};';

// ---------- 认证代理 ----------
//
// 实测结论：dsh 的认证是「token 换 cookie」模式 —— 带 token 的请求永远返回
// 303 + Set-Cookie，浏览器跟随重定向后凭 cookie 访问。但 dsh 对 Unix socket
// 进来的请求不认可 cookie（同 cookie 经 TCP 200、经 socket 303，实测）。
// 若每次转发都注入 token，浏览器会陷入 303 循环（这正是"Not Found"的根源之一）。
//
// 解法：认证完全由桥接器代理 ——
//   1. 桥接器持有内存 cookie，首次（或失效时）用 token 换取
//   2. 转发请求时附带 cookie；若 dsh 仍返回 303，则在服务器端跟随重定向
//      （最多 5 跳），把最终内容直接返回浏览器
//   3. 浏览器全程不需要 token/cookie，只看到 200

const COOKIE_JAR = { value: null }; // dsh-auth-* cookie 值

function dshRequest(reqPath, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const headers = {
            host: `127.0.0.1:${DSH_PORT}`,
            accept: '*/*',
            ...extraHeaders,
        };
        if (COOKIE_JAR.value) headers.cookie = COOKIE_JAR.value;
        const up = http.request({
            hostname: '127.0.0.1',
            port: DSH_PORT,
            path: reqPath,
            headers,
        }, resolve);
        up.on('error', reject);
        up.end();
    });
}

// 用 token 换取 cookie（服务器端完成，浏览器无感知）。
// 注意：带 token 的请求 dsh 永远响应 303+新 cookie，因此 token 只在此处用一次，
// 日常转发绝不能携带，否则陷入 303 循环。
async function ensureCookie(force = false) {
    if (COOKIE_JAR.value && !force) return;
    const token = process.env.DSH_AUTH_TOKEN;
    if (!token) return;
    const res = await new Promise((resolve, reject) => {
        const up = http.request({
            hostname: '127.0.0.1',
            port: DSH_PORT,
            path: '/?token=' + token,
            headers: { host: `127.0.0.1:${DSH_PORT}`, accept: '*/*' },
        }, resolve);
        up.on('error', reject);
        up.end();
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie && setCookie.length) {
        COOKIE_JAR.value = setCookie.map((c) => c.split(';')[0]).join('; ');
        console.log('[Bridge] 已通过 token 换取会话 cookie');
    }
}

// 服务器端跟随 303 重定向，返回最终非 3xx 响应。
// 若 cookie 失效（dsh 继续发 303），强制用 token 重换 cookie 后重试。
async function followAndResolve(reqPath, maxHops = 5) {
    let path = reqPath;
    let refreshed = false;
    for (let i = 0; i < maxHops; i++) {
        const res = await dshRequest(path);
        const isRedirect = [301, 302, 303, 307].includes(res.statusCode) && res.headers.location;
        if (!isRedirect) return res;

        // 记录 dsh 重新签发的 cookie
        const sc = res.headers['set-cookie'];
        if (sc && sc.length) COOKIE_JAR.value = sc.map((c) => c.split(';')[0]).join('; ');

        // 首次 303 说明签发时 cookie 未生效：强制用 token 重换一次
        if (!refreshed) {
            refreshed = true;
            await ensureCookie(true);
            continue; // 用新 cookie 重放当前 path（不带 token）
        }

        const loc = res.headers.location;
        if (loc.startsWith('/')) path = loc;
        else if (loc.startsWith('.')) {
            const base = path.split('?')[0].replace(/\/[^/]*$/, '');
            path = base + '/' + loc.replace(/^\.\//, '');
        } else {
            path = loc;
        }
    }
    throw new Error('重定向次数超限');
}

function proxyRequest(req, res) {
    (async () => {
        try {
            // 剥离网关前缀：/app/dsh/xxx -> /xxx（dsh 按根路径服务）
            const reqPath = stripGatewayPrefix(req.url);
            await ensureCookie();

            // GET/HEAD 走"跟随重定向"通道；其他方法（POST 等）直接转发
            // 认证统一由桥接器的 cookie 完成，所有请求均不携带 token
            let upRes;
            if (req.method === 'GET' || req.method === 'HEAD') {
                upRes = await followAndResolve(reqPath);
            } else {
                upRes = await new Promise((resolve, reject) => {
                    const headers = {
                        ...req.headers,
                        host: `127.0.0.1:${DSH_PORT}`,
                    };
                    if (COOKIE_JAR.value) headers.cookie = COOKIE_JAR.value;
                    const up = http.request({
                        hostname: '127.0.0.1',
                        port: DSH_PORT,
                        path: reqPath,
                        method: req.method,
                        headers,
                    }, resolve);
                    up.on('error', reject);
                    req.pipe(up);
                });
                const sc = upRes.headers['set-cookie'];
                if (sc && sc.length) COOKIE_JAR.value = sc.map((c) => c.split(';')[0]).join('; ');
            }

            const ct = upRes.headers['content-type'] || '';
            const shouldRewrite = ct.includes('text/html') || ct.includes('javascript') || ct.includes('css');
            const outHeaders = { ...upRes.headers };
            // 浏览器不需要 dsh 的 cookie/认证相关头（认证由桥接器代理）
            delete outHeaders['set-cookie'];

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
        } catch (err) {
            console.error('[Bridge] 转发失败:', err.message);
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('DSH 尚未就绪，请稍后刷新重试\n');
        }
    })();
}

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
            if (COOKIE_JAR.value) lines.push(`Cookie: ${COOKIE_JAR.value}`);
            if (!hasCookie && COOKIE_JAR.value) { /* 已注入 */ }
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
        delete upHeaders.cookie;
        if (COOKIE_JAR.value) upHeaders.cookie = COOKIE_JAR.value;
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
