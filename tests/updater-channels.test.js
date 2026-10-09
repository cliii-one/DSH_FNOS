/**
 * dsh-updater 通道能力测试（宿主端，Node 模拟宿主，无需网络）。
 * 运行：node tests/updater-channels.test.js
 *
 * 覆盖：路由注册契约、默认通道（只跟 next）、预览开关的读取与校验分支。
 * 刻意不触发真正的 npm 查询——POST /settings 的合法分支会联网检查，
 * 这里只打校验失败分支，保证测试离线可跑、可重复。
 */
let failed = 0;
const check = (ok, name) => { console.log((ok ? '✓' : '✗') + ' ' + name); if (!ok) failed++; };

/** 假响应：记录状态码与响应体，供断言。 */
function fakeRes() {
    return {
        code: 0,
        body: '',
        writeHead(code) { this.code = code; },
        end(chunk) { this.body = chunk; },
    };
}

/** 假请求：只带方法、头与可选请求体。 */
function fakeReq(method, { headers = {}, body } = {}) {
    const listeners = {};
    const req = {
        method,
        headers,
        on(event, fn) { (listeners[event] ??= []).push(fn); return req; },
    };
    // 模拟流式请求体：下一 tick 依次派发，保证 readBody 能拿到内容
    if (body !== undefined) {
        setImmediate(() => {
            for (const fn of listeners.data ?? []) fn(Buffer.from(body));
            for (const fn of listeners.end ?? []) fn();
        });
    }
    return req;
}

(async () => {
    const mod = await import('../plugin/lib/index.js');
    check(mod.name === 'dsh-updater', '插件名为 dsh-updater');

    // 收集 apply 注册的路由，并让 effect 立即执行（cordis 的行为）
    const routes = new Map();
    const fakeWebServer = {
        register({ path, handler }) {
            routes.set(path, handler);
            return () => routes.delete(path);
        },
    };
    const ctx = {
        webServer: fakeWebServer,
        logger: { info() {}, warn() {} },
        effect(fn) { return fn(); },
    };
    mod.apply(ctx);

    check(routes.has('/dsh-updater/status'), '已注册 /dsh-updater/status');
    check(routes.has('/dsh-updater/settings'), '已注册 /dsh-updater/settings（新增）');
    check(routes.has('/dsh-updater/check'), '已注册 /dsh-updater/check');
    check(routes.has('/dsh-updater/download'), '已注册 /dsh-updater/download');
    check(routes.has('/dsh-updater/install'), '已注册 /dsh-updater/install');

    // GET /settings：默认只跟 next（未开启预览通道）
    const getRes = fakeRes();
    await routes.get('/dsh-updater/settings')(fakeReq('GET'), getRes);
    const settings = JSON.parse(getRes.body);
    check(settings.previewChannel === false, '默认不开启预览通道');
    check(Array.isArray(settings.channels) && settings.channels.length === 1
        && settings.channels[0] === 'next', '默认通道列表仅含 next');

    // GET /status：应带通道信息，供卡片展示来源
    const statusRes = fakeRes();
    routes.get('/dsh-updater/status')(fakeReq('GET'), statusRes);
    const status = JSON.parse(statusRes.body);
    check(status.distTag === 'next', 'status 报告 distTag=next');
    check(Array.isArray(status.channels) && status.channels.includes('next'), 'status 报告启用的通道');
    check(typeof status.currentVersion === 'string', 'status 报告当前版本');

    // POST /settings 校验分支：非布尔值必须拒绝，且不应触发联网检查。
    // 约定与 /download、/install 一致：业务错误回 200 + error 状态 + 可读原因，
    // 这样前端能显示具体原因，而不是退化成一句"HTTP 400"。
    const badRes = fakeRes();
    await routes.get('/dsh-updater/settings')(
        fakeReq('POST', { headers: { 'content-type': 'application/json' }, body: '{"previewChannel":"yes"}' }),
        badRes,
    );
    const bad = JSON.parse(badRes.body);
    check(badRes.code === 200 && bad.phase === 'error', '非布尔 previewChannel 回 200 + error 状态');
    check(bad.failedOperation === 'settings', '错误归属 settings 操作');
    check(/布尔/.test(bad.message ?? ''), '错误原因可读（含"布尔"）');

    // 非 JSON 体同样拒绝，且不把解析器原文泄露出去
    const badJsonRes = fakeRes();
    await routes.get('/dsh-updater/settings')(
        fakeReq('POST', { headers: { 'content-type': 'application/json' }, body: 'not-json' }),
        badJsonRes,
    );
    const badJson = JSON.parse(badJsonRes.body);
    check(badJson.phase === 'error' && /合法 JSON/.test(badJson.message ?? ''), '非法 JSON 给出可读原因');

    // 方法校验：DELETE 必须 405
    const methodRes = fakeRes();
    await routes.get('/dsh-updater/settings')(fakeReq('DELETE'), methodRes);
    check(methodRes.code === 405, '不支持的方法返回 405');

    if (failed > 0) process.exit(1);
    console.log('\n全部通过');
})();
