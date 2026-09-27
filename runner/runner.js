/**
 * DSH - 飞牛 fnOS 运行器 (Runner)
 *
 * 职责（只做三件事）：
 *   1. 启动 dsh web，仅监听 127.0.0.1:DSH_PORT（外部无法直连内部服务）
 *   2. 在 0.0.0.0:PORT 监听，反向代理到内部 dsh web ——
 *      这是飞牛桌面入口（type=iframe，port=3082）实际访问的端口
 *   3. 代理时补两件事：
 *      a) 自签 dsh 认证 cookie（dsh 的浏览器认证机制，见下）
 *      b) 注入 crypto.randomUUID polyfill（局域网 HTTP 非安全上下文需要）
 *
 * 认证说明：
 *   dsh 的浏览器认证 cookie 由 .dsh/.credentials.yaml 中
 *   client-connection/browser-session 的 secret 以 HMAC-SHA256 签发：
 *     cookie 名 = "dsh-auth-" + base64url(sha256(authority))
 *     cookie 值 = "v1." + base64url(payload) + "." + base64url(HMAC(secret, payload))
 *   本运行器预置该 secret 后即可自行签发有效 cookie，
 *   浏览器无需处理 token 或登录跳转。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'data');

// 内部端口：dsh web 只监听回环，外部一律经本代理访问
const DSH_PORT = parseInt(process.env.DSH_PORT || '3083', 10);
// 对外端口：飞牛桌面入口按 manifest 的 service_port 访问
const SERVICE_PORT = parseInt(process.env.PORT || '3082', 10);

const NODE_BIN = process.env.DSH_NODE_BIN || 'node';
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

// umask 0：DSH 创建的文件对 NAS 用户与 SMB 完全可读写
try { process.umask(0); } catch (e) {}

// 注入脚本：局域网 HTTP 属于非安全上下文，部分浏览器缺少 crypto.randomUUID
const POLYFILL = 'if(typeof crypto!=="undefined"&&!crypto.randomUUID){crypto.randomUUID=function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(Math.random()*0x3|0x8);return v.toString(16);});}};';

// 本地应用标记：dsh 前端通过地址栏 hostname 判断是否回环访问
//   isLoopback = transport?.ownsHost === true || isLoopbackHostname(location.hostname)
// 非回环（如 http://NAS_IP:3082）时，设置镜像会降级为 memory 模式且不发起请求，
// 界面报「settings are unavailable in this browser」，表现为无法加载/添加模型。
// 桌面客户端由宿主注入 { ownHost: true } 规避该限制；本应用以端口方式提供
// 桌面入口（同一台 NAS、已通过飞牛登录），故在此补同样的标记。
const LOCAL_APP_MARK = 'if(typeof globalThis!=="undefined"){globalThis.__DSH_TRANSPORT__={...(globalThis.__DSH_TRANSPORT__||{}),ownsHost:true};}';

// ---------- 认证 cookie ----------

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeBase64Url(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

// dsh 的配置目录：优先 $DSH_HOME（即 .dsh 目录本身），回退 $HOME/.dsh
function resolveDshHomeDir() {
    const explicit = process.env.DSH_HOME;
    if (explicit && explicit.trim().length > 0) return explicit;
    return path.join(process.env.HOME || VAR_DIR, '.dsh');
}

// 确保 credentials.yaml 中有 browser-session secret，返回其 Buffer 形式
function ensureBrowserSessionSecret() {
    const credPath = path.join(resolveDshHomeDir(), '.credentials.yaml');
    const record = (secretStr) =>
        `records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secretStr}\n`;
    try {
        if (fs.existsSync(credPath)) {
            const content = fs.readFileSync(credPath, 'utf-8');
            const m = content.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/);
            if (m) return decodeBase64Url(m[1]);
        }
        const secretStr = encodeBase64Url(crypto.randomBytes(32));
        fs.mkdirSync(path.dirname(credPath), { recursive: true, mode: 0o700 });
        if (fs.existsSync(credPath)) {
            let content = fs.readFileSync(credPath, 'utf-8');
            content = /^records:\s*$/m.test(content)
                ? content.replace(/^records:\s*$/m, `records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secretStr}`)
                : content + `\n${record(secretStr)}`;
            fs.writeFileSync(credPath, content, { mode: 0o600 });
        } else {
            fs.writeFileSync(credPath, `version: 1\n${record(secretStr)}`, { mode: 0o600 });
        }
        console.log('[Runner] 已预置 browser-session 认证密钥');
        return decodeBase64Url(secretStr);
    } catch (e) {
        console.warn('[Runner] 预置认证密钥失败:', e.message);
        return null;
    }
}

// 自签认证 cookie（缓存 12 小时，避免每个请求都算签名）
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
    cachedAuthCookie = `${cookieName}=v1.${body}.${encodeBase64Url(sig)}`;
    lastCookieGenTime = now;
    return cachedAuthCookie;
}

// 构造转发头：注入自签 cookie，并丢弃浏览器原始来源头
function buildUpstreamHeaders(req) {
    const authCookie = getAuthCookie();
    const incoming = req.headers['cookie'] || '';
    const headers = {
        ...req.headers,
        host: `127.0.0.1:${DSH_PORT}`,
        cookie: authCookie ? (incoming ? `${incoming}; ${authCookie}` : authCookie) : incoming,
    };
    // dsh 会校验 Origin/Referer 必须与自身 authority 一致，不匹配即拒绝。
    // 屏蔽浏览器原始来源（代理端口/NAS 地址），浏览器信任由飞牛桌面入口承载。
    delete headers.origin;
    delete headers.referer;
    // 关压缩：HTML 需要读取后注入 polyfill
    if ((req.headers.accept || '').includes('text/html')) delete headers['accept-encoding'];
    return headers;
}

// ---------- 反向代理 ----------

function proxyRequest(req, res) {
    const upstream = http.request({
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: req.url,
        method: req.method,
        headers: buildUpstreamHeaders(req),
    }, (upRes) => {
        const outHeaders = { ...upRes.headers };
        // 认证由本代理负责，dsh 下发的 cookie 无需透传给浏览器
        delete outHeaders['set-cookie'];

        const ct = upRes.headers['content-type'] || '';
        const isHtml = ct.includes('text/html');
        if (!isHtml) {
            res.writeHead(upRes.statusCode, outHeaders);
            upRes.pipe(res);
            return;
        }

        // HTML：读取全文，注入本地应用标记与 polyfill 后返回。
        // 两者都必须先于页面脚本执行，故插入 <head> 起始处。
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf-8');
            const tag = `<script>${LOCAL_APP_MARK}${POLYFILL}</script>`;
            // 优先插入 <head> 起始；否则紧随 <body> 之后；再不行才追加到末尾
            let body;
            if (html.includes('<head>')) {
                body = html.replace('<head>', `<head>${tag}`);
            } else if (html.includes('<body>')) {
                body = html.replace('<body>', `<body>${tag}`);
            } else if (html.includes('</body>')) {
                body = html.replace('</body>', `${tag}</body>`);
            } else {
                body = html + tag;
            }
            const out = Buffer.from(body, 'utf-8');
            outHeaders['content-length'] = out.length;
            delete outHeaders['content-encoding'];
            delete outHeaders['transfer-encoding'];
            res.writeHead(upRes.statusCode, outHeaders);
            res.end(out);
        });
    });

    upstream.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('DSH 尚未就绪，请稍后刷新重试\n');
    });
    req.pipe(upstream);
}

// WebSocket 升级：透传到 dsh（同样注入认证 cookie）
function handleUpgrade(req, socket, head) {
    const upstream = net.connect(DSH_PORT, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const name = req.rawHeaders[i];
            const lower = name.toLowerCase();
            // 这几个头由本代理统一处理（原值必须跳过，避免重复头）：
            //   host   -> 连接目标
            //   cookie -> 注入自签认证 cookie
            //   origin/referer -> 直接丢弃（dsh 只接受与自身 authority 一致的来源，
            //                     实测无 Origin 可正常握手）
            if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue;
            lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
        }
        lines.push(`Host: 127.0.0.1:${DSH_PORT}`);
        const authCookie = getAuthCookie();
        if (authCookie) lines.push(`Cookie: ${authCookie}`);
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    const cleanup = () => { try { upstream.destroy(); } catch (e) {} try { socket.destroy(); } catch (e) {} };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
}

// ---------- 生命周期 ----------

let dshChild = null;
let server = null;

function shutdown(signal) {
    console.log(`[Runner] 收到 ${signal}，正在退出`);
    if (server) { try { server.close(); } catch (e) {} }
    if (dshChild && dshChild.exitCode === null) {
        try { dshChild.kill('SIGTERM'); } catch (e) {}
    }
    // 给子进程 3 秒宽限；超时由 cmd/main 兜底强杀
    setTimeout(() => process.exit(0), 3000).unref();
}

function startDsh() {
    // dsh 启动时读取 credentials.yaml，故必须在启动前预置密钥。
    // 工作目录用 HOME（数据目录），与 cmd/main 保持一致。
    ensureBrowserSessionSecret();
    const child = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(DSH_PORT), '--no-open'], {
        env: { ...process.env },
        cwd: process.env.HOME || VAR_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
        console.log(`[Runner] dsh web 已退出 (${code})，运行器同步退出`);
        process.exit(code === null ? 1 : code);
    });
    return child;
}

function startProxy() {
    const srv = http.createServer(proxyRequest);
    srv.on('upgrade', handleUpgrade);
    return new Promise((resolve, reject) => {
        srv.listen(SERVICE_PORT, '0.0.0.0', () => {
            console.log(`[Runner] 代理已就绪 0.0.0.0:${SERVICE_PORT} -> 127.0.0.1:${DSH_PORT}`);
            resolve(srv);
        });
        srv.on('error', reject);
    });
}

async function main() {
    if (!fs.existsSync(DSH_BIN)) {
        console.error(`[Runner] FATAL: 未找到 dsh 入口 ${DSH_BIN}`);
        process.exit(1);
    }
    fs.mkdirSync(VAR_DIR, { recursive: true });

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    dshChild = startDsh();
    try {
        server = await startProxy();
    } catch (e) {
        console.error(`[Runner] FATAL: 端口 ${SERVICE_PORT} 监听失败: ${e.message}`);
        dshChild.kill('SIGTERM');
        process.exit(1);
    }
    console.log(`[Runner] 启动完成 (app=${APP_DIR}, var=${VAR_DIR})`);
}

main();
