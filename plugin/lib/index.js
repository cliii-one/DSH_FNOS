/**
 * dsh-updater 宿主端：版本检查、下载预装、原子替换与回滚。
 *
 * 设计对标官方桌面端 apps/desktop/src/update-coordinator.ts：
 *   idle → checking → available → downloading → verifying → ready → installing
 *                                                     ↓ 失败
 *                                                   error（可恢复）
 *
 * 与桌面端的差异（环境决定）：
 *   - 桌面端用 electron-updater 下载整套 Electron 安装包并 quitAndInstall；
 *   - 本应用运行在 NAS 上，更新对象是 node_modules，因此：
 *       下载  = npm 安装新版到同分区的 staging 目录
 *       安装  = 停止服务 → 原子 rename 替换 → 重启 → 健康检查 → 失败回滚
 *   - 安装必须由独立进程完成（要替换的正是本进程脚下的目录），
 *     故 install 阶段派生 lib/install.mjs 后退出本进程。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-updater';

/** 本插件要升级的包（DSH 本体）。 */
const PKG = '@deepseek-ai/dsh';
/** 版本来源标签：上游 npm 的 latest 滞后于 master，必须用 next。 */
const DIST_TAG = 'next';
/** 检查间隔与抖动，对标桌面端 update-schedule 的默认值（10 分钟）。 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const CHECK_JITTER = 0.2;
/** HTTP 路由前缀。 */
const API_PREFIX = '/dsh-updater';
/** 依赖服务：webServer 提供路由注册，timer 提供定时器。 */
export const inject = ['webServer'];

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** semver 解析（与上游 updater 同规则：预发布段按数值比较）。 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(v) {
    const m = SEMVER_RE.exec(String(v ?? '').trim());
    if (m === null) return null;
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
}

/** 版本比较：返回负数/0/正数；任一侧非法时返回 null。 */
function compareVersions(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (pa === null || pb === null) return null;
    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
    }
    // 正式版 > 同号预发布
    if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
    if (pa.pre.length === 0) return 1;
    if (pb.pre.length === 0) return -1;
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i];
        const y = pb.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            if (Number(x) !== Number(y)) return Number(x) - Number(y);
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ *
 * 路径与环境
 * ------------------------------------------------------------------ */

/** 应用内容目录（安装后即 TRIM_APPDEST，含 node_modules）。 */
function appDir() {
    return process.env.TRIM_APPDEST || process.cwd();
}

/** 数据目录：优先共享目录，回退 TRIM_PKGVAR（与 cmd/main 的推导一致）。 */
function dataDir() {
    const shares = (process.env.TRIM_DATA_SHARE_PATHS ?? '').split(':').map((s) => s.trim()).filter(Boolean);
    return shares[0] ?? process.env.TRIM_PKGVAR ?? process.env.HOME ?? appDir();
}

/** npm 可执行文件：用应用中心 nodejs_v24 依赖自带的 npm。 */
function npmBin() {
    const candidate = '/var/apps/nodejs_v24/target/bin/npm';
    return existsSync(candidate) ? candidate : 'npm';
}

/** 已安装的 DSH 版本。 */
function installedVersion() {
    try {
        const p = join(appDir(), 'node_modules', PKG, 'package.json');
        return JSON.parse(readFileSync(p, 'utf8')).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

/** staging 目录：与 node_modules 同分区，保证 install 阶段 rename 是原子操作。 */
function stagingDir() {
    return join(appDir(), '.update-staging');
}

/** 运行升级所需的应用用户（node_modules 属主）。 */
function appUser() {
    try {
        return statSync(join(appDir(), 'node_modules')).uid;
    } catch {
        return undefined;
    }
}

/* ------------------------------------------------------------------ *
 * 更新状态机（对标桌面端 update-coordinator）
 * ------------------------------------------------------------------ */

/** 当前状态；publish 后由客户端轮询读取。 */
let state = { phase: 'idle' };
/** 已确认可用的候选版本；由 check 写入，download/install 校验其一致性。 */
let candidate;
/** 预装是否已完成。 */
let downloaded = false;
/** 正在进行的操作，避免并发重入。 */
let pending = null;
/** 定时检查句柄。 */
let timer;

function setState(next) {
    state = next;
    return state;
}

/** 组装失败状态（错误分类交给前端做本地化，与桌面端一致）。 */
function failure(error, failedOperation) {
    return {
        phase: 'error',
        failedOperation,
        ...(candidate === undefined ? {} : { version: candidate }),
        message: error instanceof Error ? error.message : String(error),
    };
}

/** 查询 registry 上 next 标签的版本。 */
function fetchLatestVersion(signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(npmBin(), ['view', `${PKG}@${DIST_TAG}`, 'version'], {
            env: process.env,
            signal,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`查询版本失败: ${err.trim() || `exit ${code}`}`));
                return;
            }
            resolve(out.trim());
        });
    });
}

/** 检查更新：对标桌面端 doCheck。 */
async function check() {
    if (pending?.kind === 'download') return state;
    pending = { kind: 'check' };
    setState({ phase: 'checking' });
    try {
        const current = installedVersion();
        const latest = await fetchLatestVersion();
        if (latest === '') throw new Error('registry 未返回版本号');
        const cmp = compareVersions(latest, current);
        if (cmp === null) throw new Error(`版本号无法比较：${current} / ${latest}`);
        candidate = cmp > 0 ? latest : undefined;
        downloaded = false;
        return setState(candidate === undefined
            ? { phase: 'idle', currentVersion: current }
            : { phase: 'available', version: candidate, currentVersion: current });
    } catch (error) {
        return setState(failure(error, 'check'));
    } finally {
        pending = undefined;
    }
}

/** 下载（预装）：对标桌面端 download，把新版装进 staging。 */
async function download(version) {
    if (downloaded) return state;
    if (candidate === undefined) throw new Error('尚未检查到可用的新版本');
    if (version !== candidate) throw new Error('确认的版本与当前候选不一致，请重新检查');
    if (pending !== undefined) return state;

    pending = { kind: 'download' };
    setState({ phase: 'downloading', version, percent: 0 });
    const dir = stagingDir();
    try {
        rmSync(dir, { recursive: true, force: true });
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
            name: 'dsh-fnos-app-update',
            version: '1.0.0',
            private: true,
            dependencies: { [PKG]: version },
        }, null, 2));

        setState({ phase: 'downloading', version, percent: 10 });
        await new Promise((resolve, reject) => {
            const child = spawn(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
                cwd: dir,
                env: process.env,
            });
            let err = '';
            child.stderr.on('data', (d) => { err += d; });
            child.on('error', reject);
            child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`安装失败: ${err.trim() || `exit ${code}`}`))));
        });

        // 校验：对标桌面端的 verifying 阶段
        setState({ phase: 'verifying', version });
        const binJs = join(dir, 'node_modules', PKG, 'lib', 'bin.js');
        if (!existsSync(binJs)) throw new Error('新版缺少 lib/bin.js，安装包不完整');
        const staged = JSON.parse(readFileSync(join(dir, 'node_modules', PKG, 'package.json'), 'utf8')).version;
        if (staged !== version) throw new Error(`预装版本(${staged})与目标(${version})不一致`);

        downloaded = true;
        return setState({ phase: 'ready', version });
    } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        downloaded = false;
        return setState(failure(error, 'download'));
    } finally {
        pending = undefined;
    }
}

/** 安装：派发独立进程完成替换与重启，本进程随即退出。 */
function install(version) {
    if (!downloaded) throw new Error('新版尚未下载完成');
    if (version !== candidate) throw new Error('确认的版本与当前候选不一致');

    const child = spawn(process.execPath, [join(import.meta.dirname, 'install.mjs')], {
        env: {
            ...process.env,
            DSH_UPDATE_VERSION: version,
            DSH_UPDATE_FROM: installedVersion(),
        },
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    setState({ phase: 'installing', version });
    // 留出时间让 HTTP 响应回到浏览器，再退出以便替换 node_modules
    setTimeout(() => process.exit(0), 800);
    return state;
}

/* ------------------------------------------------------------------ *
 * HTTP 接口
 * ------------------------------------------------------------------ */

function sendJson(res, code, payload) {
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

/** 读取请求体（限制大小，避免异常请求占满内存）。 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 64 * 1024) reject(new Error('请求体过大'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/** 同源校验：只接受来自本应用页面的请求。 */
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // 同源 GET 可能不带 Origin
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

/**
 * 插件入口。
 * @param ctx - 宿主上下文，含 webServer 服务。
 */
export function apply(ctx) {
    /** 注册一个路由并随插件卸载自动清理。 */
    const route = (path, handler) => {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
    };

    // 当前状态（前端轮询）
    route(`${API_PREFIX}/status`, (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        sendJson(res, 200, { ...state, currentVersion: installedVersion(), package: PKG, distTag: DIST_TAG });
    });

    // 检查更新
    route(`${API_PREFIX}/check`, async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
        sendJson(res, 200, await check());
    });

    // 下载（预装）
    route(`${API_PREFIX}/download`, async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
        try {
            const { version } = JSON.parse(await readBody(req) || '{}');
            if (typeof version !== 'string' || version === '') return sendJson(res, 400, { error: 'missing version' });
            sendJson(res, 200, await download(version));
        } catch (error) {
            sendJson(res, 200, failure(error, 'download'));
        }
    });

    // 安装（替换并重启）
    route(`${API_PREFIX}/install`, async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
        try {
            const { version } = JSON.parse(await readBody(req) || '{}');
            if (typeof version !== 'string' || version === '') return sendJson(res, 400, { error: 'missing version' });
            sendJson(res, 200, install(version));
        } catch (error) {
            sendJson(res, 200, failure(error, 'install'));
        }
    });

    // 定时检查（带抖动，避免多实例同时打 registry）
    ctx.effect(() => {
        const schedule = () => {
            const jitter = 1 + (Math.random() * 2 - 1) * CHECK_JITTER;
            timer = setTimeout(async () => {
                if (state.phase === 'idle' || state.phase === 'error') await check();
                schedule();
            }, Math.round(CHECK_INTERVAL_MS * jitter));
            timer.unref?.();
        };
        // 启动后延迟首次检查，避免与 dsh 启动争抢资源
        timer = setTimeout(async () => {
            await check();
            schedule();
        }, 15_000);
        timer.unref?.();
        return () => clearTimeout(timer);
    }, 'dsh-updater: periodic check');

    ctx.logger?.info?.(`[dsh-updater] 已就绪（当前 ${installedVersion()}，来源 ${PKG}@${DIST_TAG}）`);
}
