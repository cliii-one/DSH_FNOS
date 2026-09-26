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

// 回退端口模式（DSH_FALLBACK_PORT=1 时启用）：额外监听 0.0.0.0:PORT 对局域网服务。
// 仅在用户显式关闭统一网关时使用，默认走更安全的网关模式。
const FALLBACK_ENABLED = process.env.DSH_FALLBACK_PORT === '1';
const FALLBACK_PORT = parseInt(process.env.PORT || '3082', 10);

const NODE_BIN = process.env.DSH_NODE_BIN || 'node';
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// umask 0：DSH 创建的文件对 NAS 用户/SMB 完全可读写
try { process.umask(0); } catch (e) {}

// ---------- 第一步：启动 dsh web ----------

function startDsh() {
    const dsh = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--no-open'], {
        env: { ...process.env, HOME: VAR_DIR },
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

function proxyRequest(req, res) {
    const upstream = http.request({
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${DSH_PORT}` },
    }, (upRes) => {
        const ct = upRes.headers['content-type'] || '';
        const shouldInject = ct.includes('text/html') || ct.includes('javascript');
        if (!shouldInject) {
            res.writeHead(upRes.statusCode, upRes.headers);
            upRes.pipe(res);
            return;
        }
        // HTML/JS 响应：追加 polyfill 后再回给网关
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
            const body = Buffer.concat([...chunks.map(Buffer.from), Buffer.from(POLYFILL)]);
            const headers = { ...upRes.headers };
            headers['content-length'] = body.length;
            delete headers['content-encoding'];
            delete headers['transfer-encoding'];
            res.writeHead(upRes.statusCode, headers);
            res.end(body);
        });
    });
    req.pipe(upstream);
    upstream.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('DSH 尚未就绪，请稍后刷新重试\n');
    });
}

// ---------- 回退端口模式：局域网 TCP 监听（仅网关关闭时启用） ----------

function startFallbackProxy() {
    const server = http.createServer(proxyRequest);

    // WebSocket 升级：直接透传
    server.on('upgrade', (req, socket, head) => {
        const upstream = net.connect(DSH_PORT, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
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
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: DSH_PORT,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${DSH_PORT}` },
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
