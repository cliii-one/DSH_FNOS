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
 *   - 本应用运行在 NAS 上，更新对象是 node_modules，且应用不支持自重启，
 *     因此：
 *       下载  = npm 安装新版到同分区的 staging 目录
 *       安装  = 请求运行器（runner.js）就地完成：
 *               停 dsh 子进程 → 原子替换 → 重新拉起 → 健康检查 → 失败回滚
 *   - 运行器只依赖 Node 内置模块、不加载 node_modules，可在自身运行期间
 *     安全替换该目录，且**应用本身始终存活**（飞牛侧无需手动启停）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-updater';

/** 本插件要升级的包（DSH 本体）。 */
const PKG = '@deepseek-ai/dsh';
/**
 * 版本来源通道（npm dist-tag）。
 *
 * 只跟 `next`：上游的 latest 标签滞后于主线，next 才是主线预发布，跟踪它最稳。
 * `alpha` 是更超前的实验通道——实测上游把 0.2.1-alpha.1 只挂在 alpha 上，
 * 而 next 停在 0.2.0-rc.2，因此只查 next 会"永远看不到" alpha 版本。
 * 默认不查 alpha（稳定性优先），由用户在设置页手动开启。
 */
const DEFAULT_CHANNEL = 'next';
const PREVIEW_CHANNEL = 'alpha';
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


/**
 * 运行时变量目录：与 runner 的 VAR_DIR 推导完全一致（TRIM_PKGVAR）。
 * 更新请求/结果文件放这里——runner 在 VAR_DIR 轮询请求文件，
 * 两侧必须指向同一目录，否则 runner 永远收不到请求（实测踩坑：
 * 写在共享目录 @appshare 下而 runner 监听的是 @appdata，更新卡死在
 * installing）。
 */
function varDir() {
    return process.env.TRIM_PKGVAR ?? appDir();
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

/* ------------------------------------------------------------------ *
 * 更新状态机（对标桌面端 update-coordinator）
 * ------------------------------------------------------------------ */

/** 当前状态；publish 后由客户端轮询读取。 */
let state = { phase: 'idle' };
/** 已确认可用的候选版本；由 check 写入，download/install 校验其一致性。 */
let candidate;
/** 候选版本来自哪个通道（next / alpha），仅用于界面展示与日志。 */
let candidateChannel;
/** 预装是否已完成。 */
let downloaded = false;
/** 正在进行的操作，避免并发重入。 */
let pending = null;
/** 定时检查句柄。 */
let timer;

/* ------------------------------------------------------------------ *
 * 设置：预览通道开关
 * ------------------------------------------------------------------ */

/**
 * 设置文件路径。放在 TRIM_PKGVAR（应用数据目录），与 runner 的
 * 更新请求文件同目录——该目录只有应用用户可写，天然不对外暴露。
 */
function settingsFile() {
    return join(varDir(), 'updater-settings.json');
}

/**
 * 是否启用 alpha（预览）通道。
 *
 * 默认关闭：只看 next，稳定性优先。开启后额外查询 alpha 并取两者较高的
 * 版本。**只影响"能否发现"**，安装仍需用户在卡片上手动确认。
 */
let previewEnabled = false;

/** 读取设置文件；文件缺失或损坏时保持默认值（不抛错，避免拖垮启动）。 */
function loadSettings() {
    try {
        const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
        previewEnabled = parsed?.previewChannel === true;
    } catch {
        previewEnabled = false;
    }
}

/** 写入设置文件；失败只返回 false，由调用方记日志（下次保存会再试）。 */
function saveSettings() {
    try {
        writeFileSync(settingsFile(), JSON.stringify({ previewChannel: previewEnabled }, null, 2));
        return true;
    } catch {
        return false;
    }
}

/** 当前启用的通道列表：始终含 next，开启预览后追加 alpha。 */
function enabledChannels() {
    return previewEnabled ? [DEFAULT_CHANNEL, PREVIEW_CHANNEL] : [DEFAULT_CHANNEL];
}

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

/** 查询 registry 上某个通道（dist-tag）指向的版本号。 */
function fetchTagVersion(tag, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(npmBin(), ['view', `${PKG}@${tag}`, 'version'], {
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

/**
 * 在当前启用的通道里取最高版本。
 *
 * 为什么是"取最高"而不是"只看 alpha"：两个通道的领先关系会变（alpha 也可能
 * 落后于 next）。同时查询再比大小，既不会漏掉 alpha 的新版本，也不会因为
 * alpha 落后而把用户降级。
 *
 * @param {string[]} channels 要查询的标签列表
 * @returns {Promise<{version: string, channel: string}>} 最高的版本及其来源通道
 */
async function resolveLatest(channels, signal) {
    const found = await Promise.all(channels.map(async (tag) => ({ tag, version: await fetchTagVersion(tag, signal) })));
    let best;
    for (const item of found) {
        if (item.version === '') continue;
        // 版本号互不可比（格式异常）时跳过，避免整次检查失败
        if (best === undefined || (compareVersions(item.version, best.version) ?? 0) > 0) best = item;
    }
    if (best === undefined) throw new Error('registry 未返回版本号');
    return { version: best.version, channel: best.tag };
}

/** 检查更新：对标桌面端 doCheck。 */
async function check() {
    if (pending?.kind === 'download') return state;
    pending = { kind: 'check' };
    setState({ phase: 'checking' });
    try {
        const current = installedVersion();
        const latest = await resolveLatest(enabledChannels());
        const cmp = compareVersions(latest.version, current);
        if (cmp === null) throw new Error(`版本号无法比较：${current} / ${latest.version}`);
        candidate = cmp > 0 ? latest.version : undefined;
        candidateChannel = latest.channel;
        downloaded = false;
        // checkedAt/latestKnown 区分「从未检查」与「已检查且已是最新」，
        // 前端据此在最新版本行显示「尚未检查」或「已是最新 vX.Y.Z」。
        return setState(candidate === undefined
            ? { phase: 'idle', currentVersion: current, latestKnown: latest.version, latestChannel: latest.channel, checkedAt: new Date().toISOString() }
            : { phase: 'available', version: candidate, channel: latest.channel, currentVersion: current, checkedAt: new Date().toISOString() });
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

/**
 * 安装：请求运行器就地替换 node_modules 并重启 dsh 子进程。
 *
 * 为什么不自己替换：要替换的正是本插件脚下的目录，进程自身无法安全换入。
 * 运行器（runner.js）只依赖 Node 内置模块、不加载 node_modules，
 * 因此由它在"停掉 dsh 子进程"后替换是安全的，且**应用本身不需要重启**。
 *
 * 触发方式用文件而非 HTTP：运行器的对外代理监听 0.0.0.0，
 * 若把更新接口挂在代理上，局域网内任何设备都能触发替换（高危）。
 * 文件位于应用数据目录，仅应用用户可写，天然不对外暴露。
 */
function install(version) {
    if (!downloaded) throw new Error('新版尚未下载完成');
    if (version !== candidate) throw new Error('确认的版本与当前候选不一致');

    const requestFile = join(varDir(), 'update-request.json');
    const resultFile = join(varDir(), 'update-result.json');
    // 清掉上一轮结果，便于区分本次
    rmSync(resultFile, { force: true });
    writeFileSync(requestFile, JSON.stringify({
        version,
        from: installedVersion(),
        stagedDir: stagingDir(),
        at: new Date().toISOString(),
    }, null, 2));

    setState({ phase: 'installing', version, channel: candidateChannel ?? DEFAULT_CHANNEL });
    // 运行器轮询该文件（2 秒一次）并执行替换；完成后 dsh 会随新版本重启
    return state;
}

/**
 * 读取运行器的更新结果。文件保留不删：网络抖动可能丢失单个响应，
 * 读后即删会让前端错过结果；改由前端记录已处理结果的 at 时间戳去重，
 * 文件在下次 install() 触发时被显式清空。
 */
function readUpdateResult() {
    const resultFile = join(varDir(), 'update-result.json');
    if (!existsSync(resultFile)) return undefined;
    try {
        return JSON.parse(readFileSync(resultFile, 'utf-8'));
    } catch {
        return undefined;
    }
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
    // 读取已保存的通道设置（默认只跟 next）
    loadSettings();

    /** 注册一个路由并随插件卸载自动清理。 */
    const route = (path, handler) => {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
    };

    // 当前状态（前端轮询；附加运行器的替换结果，供安装完成后展示）
    route(`${API_PREFIX}/status`, (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const result = readUpdateResult();
        sendJson(res, 200, {
            ...state,
            currentVersion: installedVersion(),
            package: PKG,
            distTag: DEFAULT_CHANNEL,
            channel: state.channel ?? candidateChannel ?? DEFAULT_CHANNEL,
            previewChannel: previewEnabled,
            channels: enabledChannels(),
            ...(result === undefined ? {} : { updateResult: result }),
        });
    });

    // 读取/切换预览（alpha）通道。开启后立即重新检查一次，让用户马上看到结果。
    route(`${API_PREFIX}/settings`, async (req, res) => {
        if (req.method === 'GET') {
            return sendJson(res, 200, { previewChannel: previewEnabled, channels: enabledChannels() });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
        try {
            // 请求体解析失败时给出可读原因（V8 的解析报错原文会内嵌输入片段，不外传）
            let body;
            try {
                body = JSON.parse(await readBody(req) || '{}');
            } catch {
                throw new Error('请求体不是合法 JSON');
            }
            if (typeof body.previewChannel !== 'boolean') {
                throw new Error('previewChannel 必须是布尔值');
            }
            previewEnabled = body.previewChannel;
            const saved = saveSettings();
            ctx.logger?.info?.(`[dsh-updater] 预览通道已${previewEnabled ? '开启' : '关闭'}（通道：${enabledChannels().join(', ')}）`);
            // 切换通道后原候选可能来自已关闭的通道，作废并立即重新检查
            candidate = undefined;
            candidateChannel = undefined;
            downloaded = false;
            const next = await check();
            sendJson(res, 200, { ...next, previewChannel: previewEnabled, channels: enabledChannels(), persisted: saved });
        } catch (error) {
            // 与 /download、/install 同约定：业务错误回 200 + error 状态，
            // 前端据 failedOperation 展示原因（非 2xx 只会退化成"HTTP 400"）
            sendJson(res, 200, failure(error, 'settings'));
        }
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

    ctx.logger?.info?.(`[dsh-updater] 已就绪（当前 ${installedVersion()}，通道 ${enabledChannels().join(' + ')}）`);
}
