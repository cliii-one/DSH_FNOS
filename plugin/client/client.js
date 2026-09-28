/**
 * dsh-updater 浏览器端：在设置页注入「版本更新」卡片。
 *
 * 交互对标官方桌面端 renderer/update-dialog.js：
 *   available   → 「发现新版本 vX.Y.Z」   [稍后] [下载]
 *   downloading → 进度提示（不定长，npm 安装无法给出精确百分比）
 *   ready       → 「已下载完成，重启后生效」[稍后] [立即重启安装]
 *   installing  → 「正在替换并重启…」
 *   error       → 分类文案 [重试]
 *
 * 【加载协议】DSH 的 ModuleLoader 动态 import 本 bundle 后会核对注册记录，
 * 因此模块执行期间必须同步调用 window.__ModuleLoader__.load 完成自注册，
 * 否则报 "loaded without registering ... via __ModuleLoader__.load"。
 */

window.__ModuleLoader__.load({
    id: 'dsh-updater',
    // 宿主注入 require，用于获取外部依赖（见 package.json 的 dsh.client.inject）
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;

        const react = require('react');
        const h = react.createElement;
        const { useState, useEffect, useCallback, useRef } = react;

        const name = 'dsh-updater';
        // slots：设置页插槽；locale：本地化文案
        const inject = ['slots', 'locale'];

        const API = '/dsh-updater';

        /** 卡片内的样式（用主题变量，亮暗自适应）。 */
        const STYLE_ID = 'dsh-updater-style';
        const CSS = `
.dshup-root { display: flex; flex-direction: column; gap: 10px; }
.dshup-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshup-version { font-variant-numeric: tabular-nums; }
.dshup-muted { opacity: .65; font-size: 12px; }
.dshup-actions { display: flex; gap: 8px; margin-top: 4px; }
.dshup-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128,128,128,.35));
  background: var(--dsh-bg-elevated, transparent); color: inherit; cursor: pointer; font-size: 13px; }
.dshup-btn:hover:not(:disabled) { border-color: var(--dsh-accent, #4b8bf5); }
.dshup-btn:disabled { opacity: .5; cursor: not-allowed; }
.dshup-btn.primary { border-color: var(--dsh-accent, #4b8bf5); }
.dshup-badge { font-size: 12px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsh-accent, #4b8bf5); }
.dshup-error { color: var(--dsh-danger, #d9534f); font-size: 12px; }
`;

        function ensureStyle() {
            if (document.getElementById(STYLE_ID) !== null) return;
            const el = document.createElement('style');
            el.id = STYLE_ID;
            el.textContent = CSS;
            document.head.append(el);
        }

        /** 统一请求封装：同源 POST/GET，返回 JSON。 */
        async function api(path, options = {}) {
            const res = await fetch(`${API}${path}`, {
                method: options.method ?? 'GET',
                headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        }

        /** 失败原因的分类文案（对标桌面端 update-presentation 的分类思路）。 */
        function failureText(state, t) {
            const op = state.failedOperation;
            const msg = String(state.message ?? '');
            const network = /ERR_|ETIMEDOUT|ENOTFOUND|network|registry/i.test(msg);
            if (op === 'check') return network ? t('checkNetwork') : t('checkFailed');
            if (op === 'download') return network ? t('downloadNetwork') : t('downloadFailed');
            if (op === 'install') return t('installFailed');
            return msg || t('unknown');
        }

        /** 版本更新卡片。 */
        function UpdaterCard() {
            const [state, setState] = useState({ phase: 'idle' });
            const [busy, setBusy] = useState(false);
            const [notice, setNotice] = useState('');
            const pollRef = useRef();

            const refresh = useCallback(async () => {
                try {
                    setState(await api('/status'));
                } catch { /* 状态查询失败时保持上一次显示 */ }
            }, []);

            // 挂载后取一次状态，并按阶段决定轮询频率
            useEffect(() => {
                refresh();
                return () => clearInterval(pollRef.current);
            }, [refresh]);

            useEffect(() => {
                clearInterval(pollRef.current);
                const active = state.phase === 'downloading' || state.phase === 'verifying' || state.phase === 'installing';
                pollRef.current = setInterval(refresh, active ? 2000 : 30000);
                return () => clearInterval(pollRef.current);
            }, [state.phase, refresh]);

            // 运行器完成替换后 dsh 已重启：读回结果并刷新页面加载新版。
            // 安装期间请求会短暂失败（服务在换装），轮询会自动恢复。
            useEffect(() => {
                if (state.updateResult === undefined) return;
                const ok = state.updateResult.ok === true;
                const message = ok
                    ? `已更新到 v${state.updateResult.version ?? ''}，正在刷新页面…`
                    : (state.updateResult.message ?? '更新失败，已回滚');
                setNotice(message);
                if (ok) setTimeout(() => window.location.reload(), 1500);
            }, [state.updateResult]);

            const t = useCallback((key) => {
                const dict = {
                    title: '版本更新',
                    current: '当前版本',
                    available: '发现新版本',
                    downloading: '正在下载并准备…',
                    verifying: '正在校验…',
                    ready: '新版本已就绪，可开始安装',
                    installing: '正在替换并重启，页面稍后自动刷新…',
                    latest: '已是最新版本',
                    check: '检查更新',
                    checking: '检查中…',
                    download: '下载',
                    install: '立即重启安装',
                    later: '稍后',
                    checkFailed: '检查更新失败，请稍后重试',
                    checkNetwork: '网络不可用，无法连接版本服务',
                    downloadFailed: '下载失败，已清理临时文件',
                    downloadNetwork: '网络不可用，下载中断',
                    installFailed: '安装失败，已回滚到原版本',
                    unknown: '发生未知错误',
                };
                return dict[key] ?? key;
            }, []);

            const run = useCallback(async (action, body) => {
                setBusy(true);
                setNotice('');
                try {
                    const next = await api(action, { method: 'POST', body });
                    setState(next);
                    if (next.phase === 'error') setNotice(failureText(next, t));
                } catch (error) {
                    setNotice(String(error.message ?? error));
                } finally {
                    setBusy(false);
                }
            }, [t]);



            const { phase, version, currentVersion } = state;

            return h('div', { className: 'dshup-root' }, [
                h('div', { className: 'dshup-row', key: 'head' }, [
                    h('span', { key: 'cur', className: 'dshup-muted' },
                        `${t('current')} ${currentVersion ?? '…'}`),
                    phase === 'available' && h('span', { key: 'badge', className: 'dshup-badge' },
                        `${t('available')} ${version}`),
                ]),
                // 各阶段的主提示
                phase === 'available' && h('div', { key: 'msg' }, `${t('available')} v${version}`),
                (phase === 'downloading' || phase === 'verifying') &&
                    h('div', { key: 'msg' }, phase === 'verifying' ? t('verifying') : t('downloading')),
                phase === 'ready' && h('div', { key: 'msg' }, `${t('ready')}（v${version}）`),
                phase === 'installing' && h('div', { key: 'msg' }, t('installing')),
                phase === 'error' && h('div', { key: 'msg', className: 'dshup-error' },
                    failureText(state, t)),
                (notice !== '' && phase !== 'error') &&
                    h('div', { key: 'notice', className: 'dshup-error' }, notice),
                // 操作按钮（按阶段切换，对标桌面端对话框）
                h('div', { className: 'dshup-actions', key: 'actions' }, [
                    (phase === 'idle' || phase === 'error') && h('button', {
                        key: 'check', type: 'button', className: 'dshup-btn', disabled: busy,
                        onClick: () => run('/check'),
                    }, busy ? t('checking') : t('check')),
                    phase === 'available' && h('button', {
                        key: 'download', type: 'button', className: 'dshup-btn primary', disabled: busy,
                        onClick: () => run('/download', { version }),
                    }, t('download')),
                    phase === 'ready' && h('button', {
                        key: 'install', type: 'button', className: 'dshup-btn primary', disabled: busy,
                        onClick: () => run('/install', { version }),
                    }, t('install')),
                    (phase === 'available' || phase === 'ready') && h('button', {
                        key: 'later', type: 'button', className: 'dshup-btn',
                        onClick: () => setState((s) => ({ ...s, phase: 'idle' })),
                    }, t('later')),
                ]),
            ]);
        }

        /** 注册设置页卡片。 */
        function apply(ctx) {
            ensureStyle();
            ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: 'updater',
                order: 90,
                label: () => '版本更新',
            }, UpdaterCard));
        }

        module.exports = { name, inject, apply };
        return module.exports;
    },
});
