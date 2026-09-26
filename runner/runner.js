/**
 * DSH - 飞牛 fnOS 统一运行器 (Runner)
 *
 * 职责：
 * 1. 启动上游官方 dsh web（127.0.0.1:DSH_PORT，默认 3083）
 * 2. 启动局域网反向代理（0.0.0.0:PORT，默认 3082 -> 127.0.0.1:DSH_PORT）
 *    飞牛桌面入口 iframe 直接访问 3082，绕过非安全上下文限制
 * 3. 注入 crypto.randomUUID Polyfill（旧浏览器/非 HTTPS 场景兼容）
 * 4. 精确生命周期管理：SIGTERM/SIGINT 时先杀 dsh 子进程再退出
 *
 * 与官方 deepseek-harness 应用的 runner 原理一致，去除了插件市场/pnpm
 * 自愈等对本项目不适用的逻辑，保持精简。
 */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'data');
const NODE_BIN = path.join(APP_DIR, 'bin', 'node');
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// 端口：cmd/main 已导出 PORT（对外）与 DSH_PORT（内部）
const PROXY_PORT = parseInt(process.env.PORT || '3082', 10);
const DSH_PORT = parseInt(process.env.DSH_PORT || '3083', 10);

// umask 0：DSH 创建的文件对 NAS 用户/SMB 完全可读写
try { process.umask(0); } catch (e) {}

// ---------- 第一步：启动 dsh web ----------

function startDsh() {
    const dshEnv = { ...process.env, HOME: VAR_DIR };
    const dsh = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--no-open'], {
        env: dshEnv,
        cwd: VAR_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    dsh.on('exit', (code) => {
        console.log(`[Runner] dsh web exited with code ${code}, exiting runner`);
        process.exit(code === null ? 1 : code);
    });

    return dsh;
}

// ---------- 第二步：局域网反向代理 ----------

// 把浏览器原始请求转发到 127.0.0.1:DSH_PORT
function proxyRequest(req, res) {
    const opts = {
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${DSH_PORT}` },
    };
    const upstream = http.request(opts, (upRes) => {
        // 注入 randomUUID polyfill：非安全上下文（HTTP 局域网）下旧实现会缺失
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
            let body = Buffer.concat(chunks);
            const ct = upRes.headers['content-type'] || '';
            if (ct.includes('text/html') || ct.includes('javascript')) {
                const POLYFILL = ';if(typeof crypto!=="undefined"&&!crypto.randomUUID){crypto.randomUUID=function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(Math.random()*0x3|0x8);return v.toString(16);});}};';
                body = Buffer.concat([body, Buffer.from(POLYFILL)]);
            }
            const headers = { ...upRes.headers };
            delete headers['content-length'];
            res.writeHead(upRes.statusCode, headers);
            res.end(body);
        });
        upRes.on('error', () => { try { res.end(); } catch (e) {} });
    });
    req.pipe(upstream);
    upstream.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('DSH 尚未就绪，请稍后刷新重试\n');
    });
}

function startProxy() {
    const server = http.createServer(proxyRequest);

    // WebSocket 升级：直接透传 TCP
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

    server.listen(PROXY_PORT, '0.0.0.0', () => {
        console.log(`[Runner] LAN proxy listening on 0.0.0.0:${PROXY_PORT} -> 127.0.0.1:${DSH_PORT}`);
    });

    return server;
}

// ---------- 第三步：优雅退出 ----------

let dshChild = null;
let proxyServer = null;

function shutdown(signal) {
    console.log(`[Runner] received ${signal}, shutting down`);
    if (proxyServer) {
        try { proxyServer.close(); } catch (e) {}
    }
    if (dshChild && dshChild.exitCode === null) {
        try { dshChild.kill('SIGTERM'); } catch (e) {}
    }
    // 给子进程 3 秒宽限，超时强杀
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- 启动 ----------

if (!require('fs').existsSync(DSH_BIN)) {
    console.error(`[Runner] FATAL: dsh bin not found at ${DSH_BIN}`);
    process.exit(1);
}

require('fs').mkdirSync(VAR_DIR, { recursive: true });
dshChild = startDsh();
proxyServer = startProxy();
console.log(`[Runner] DSH runner started (app=${APP_DIR}, var=${VAR_DIR})`);
