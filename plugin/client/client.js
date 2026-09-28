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
        // 官方图标组件：导航项使用，与设置页其余菜单风格一致
        const IconDownload = require('@deepseek-ai/dsh-client-ui-primitives').IconDownloadOutlineMedium;

        const name = 'dsh-updater';
        // slots：设置页插槽；locale：本地化文案
        const inject = ['slots', 'locale'];

        const API = '/dsh-updater';

        /** 卡片内的样式（用主题变量，亮暗自适应）。 */
        const STYLE_ID = 'dsh-updater-style';
        const CSS = `
.dshup-root { display: flex; flex-direction: column; gap: 0; color: var(--dsw-alias-label-primary); }

/* 头部：产品图标 + 标题 + 当前版本号 */
.dshup-head { display: flex; align-items: center; gap: 14px; padding: 18px 16px 16px; }
.dshup-head-icon { flex: none; width: 44px; height: 44px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: inherit; }
.dshup-head-icon svg { width: 24px; height: 24px; }
.dshup-head-main { min-width: 0; flex: 1; }
.dshup-title { font-size: 15px; font-weight: 600; line-height: 20px; }
.dshup-subtitle { margin-top: 2px; font-size: 12px; line-height: 17px; opacity: .6; }
.dshup-curver { flex: none; font-variant-numeric: tabular-nums; font-size: 13px;
  padding: 3px 10px; border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }

/* 信息行：标签 + 值，行间细分隔线 */
.dshup-rows { display: flex; flex-direction: column; padding: 2px 16px; }
.dshup-info { display: flex; align-items: center; justify-content: space-between;
  gap: 12px; min-height: 38px; padding: 8px 0;
  border-bottom: 1px solid var(--dsw-alias-separator, rgba(127,127,127,.18));
  font-size: 13px; }
.dshup-info:last-child { border-bottom: none; }
.dshup-info-label { opacity: .65; }
.dshup-info-value { display: inline-flex; align-items: center; gap: 8px;
  font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }

/* 新版本徽章与状态点 */
.dshup-badge { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px;
  color: var(--dsw-alias-label-accent, #2f6fed);
  background: color-mix(in srgb, var(--dsw-alias-label-accent, #2f6fed) 12%, transparent); }
.dshup-dot { width: 7px; height: 7px; border-radius: 999px; flex: none;
  background: var(--dsw-alias-label-accent, #2f6fed); }

/* 进行中状态：不定长进度条 + 动画 */
.dshup-progress { height: 4px; border-radius: 999px; overflow: hidden; margin: 10px 16px 2px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.15)); }
.dshup-progress-bar { height: 100%; width: 40%; border-radius: 999px;
  background: var(--dsw-alias-label-accent, #2f6fed); animation: dshup-slide 1.2s ease-in-out infinite; }
@keyframes dshup-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(280%); } }

/* 结果/错误提示 */
.dshup-notice { margin: 8px 16px 0; padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 18px; }
.dshup-notice.ok { color: var(--dsw-alias-label-accent, #2f6fed);
  background: color-mix(in srgb, var(--dsw-alias-label-accent, #2f6fed) 10%, transparent); }
.dshup-notice.err { color: var(--dsw-alias-label-danger, #d9534f);
  background: color-mix(in srgb, var(--dsw-alias-label-danger, #d9534f) 10%, transparent); }

/* 底部操作区：右对齐主操作 */
.dshup-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 16px 16px; }
.dshup-btn { height: 30px; padding: 0 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--dsw-alias-separator, rgba(127,127,127,.3));
  background: transparent; color: inherit; transition: background .12s ease; }
.dshup-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
.dshup-btn:disabled { opacity: .5; cursor: not-allowed; }
.dshup-btn.primary { border-color: transparent; color: var(--dsw-alias-label-onaccent, #fff);
  background: var(--dsw-alias-label-accent, #2f6fed); }
.dshup-btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--dsw-alias-label-accent, #2f6fed); }

.dshup-navwrap { display: inline-flex; align-items: center; gap: 6px; }
.dshup-navwrap svg { width: 16px; height: 16px; }
/* 设置导航按 section id 查图标表，未知 id 回退为设置齿轮（上游硬编码）。
   本插件的 label 携带自带图标，用 :has 定位所在导航按钮并隐藏默认齿轮。
   齿轮是 button 的直接子元素，我们的图标嵌在 span.navLabel 之内（隔一层），
   因此 :has() 里用后代选择器定位，再隐藏 button 下第一枚 svg（即齿轮）。 */
button:has(.dshup-navwrap .dshup-navicon) > svg:first-of-type { display: none; }
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
                    title: 'DSH 版本更新',
                    subtitle: '与上游 master 保持同步，支持自动回滚',
                    current: '当前版本',
                    latest: '最新版本',
                    status: '状态',
                    new: '新版本',
                    notChecked: '尚未检查',
                    unknownState: '—',
                    canDownload: '可下载',
                    canInstall: '已就绪，可安装',
                    available: '发现新版本',
                    downloading: '正在下载并准备',
                    verifying: '正在校验',
                    ready: '新版本已就绪，可开始安装',
                    installing: '正在替换并重启，页面稍后自动刷新',
                    check: '检查更新',
                    checking: '检查中…',
                    download: '下载',
                    install: '立即安装',
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

            // 头部图标（官方 primitives 的下载图标，与导航一致）
            const headIcon = h(IconDownload, { key: 'ic', 'aria-hidden': true });

            // 信息行构造器：label + 值节点
            const info = (key, label, value) => h('div', { className: 'dshup-info', key }, [
                h('span', { className: 'dshup-info-label', key: 'l' }, label),
                h('span', { className: 'dshup-info-value', key: 'v' }, value),
            ]);

            const active = phase === 'downloading' || phase === 'verifying' || phase === 'installing';
            const noticeText = phase === 'error' ? failureText(state, t) : (notice !== '' && phase !== 'error' ? notice : null);
            const noticeClass = phase === 'error' ? 'dshup-notice err'
                : (state.updateResult?.ok === true || /已更新/.test(notice)) ? 'dshup-notice ok' : 'dshup-notice err';

            return h('div', { className: 'dshup-root' }, [
                // 头部：图标 + 标题/副标题 + 当前版本徽章
                h('div', { className: 'dshup-head', key: 'head' }, [
                    h('div', { className: 'dshup-head-icon', key: 'icon' }, headIcon),
                    h('div', { className: 'dshup-head-main', key: 'main' }, [
                        h('div', { className: 'dshup-title', key: 't' }, t('title')),
                        h('div', { className: 'dshup-subtitle', key: 's' }, t('subtitle')),
                    ]),
                    h('span', { className: 'dshup-curver', key: 'v' }, 'v' + (currentVersion ?? '…')),
                ]),

                // 信息区：当前版本 / 最新版本（含状态）
                h('div', { className: 'dshup-rows', key: 'rows' }, [
                    info('r1', t('current'), 'v' + (currentVersion ?? '…')),
                    phase === 'available' && info('r2', t('latest'),
                        [h('span', { className: 'dshup-dot', key: 'dot' }), 'v' + version, h('span', { className: 'dshup-badge', key: 'b' }, t('new'))]),
                    (phase === 'idle' || phase === 'error') && info('r2', t('latest'),
                        phase === 'error' ? t('unknownState') : t('notChecked')),
                    phase === 'ready' && info('r2', t('latest'), 'v' + version),
                    (phase === 'available' || phase === 'ready') &&
                        h('div', { className: 'dshup-info', key: 'r3' }, [
                            h('span', { className: 'dshup-info-label', key: 'l' }, t('status')),
                            h('span', { className: 'dshup-info-value', key: 'v' },
                                phase === 'available' ? t('canDownload') : t('canInstall')),
                        ]),
                ]),

                // 进行中：不定长进度条
                active && h('div', { className: 'dshup-progress', key: 'prog' },
                    h('div', { className: 'dshup-progress-bar' })),
                active && h('div', { className: 'dshup-info', key: 'progtext', style: { borderBottom: 'none' } }, [
                    h('span', { className: 'dshup-info-label', key: 'l' },
                        phase === 'verifying' ? t('verifying') : phase === 'installing' ? t('installing') : t('downloading')),
                    h('span', { className: 'dshup-info-value', key: 'v' },
                        phase === 'installing' ? '' : (state.percent !== undefined ? state.percent + '%' : '…')),
                ]),

                // 结果 / 错误提示
                noticeText && h('div', { className: noticeClass, key: 'notice' }, noticeText),

                // 底部操作区
                h('div', { className: 'dshup-actions', key: 'actions' }, [
                    (phase === 'available' || phase === 'ready') && h('button', {
                        key: 'later', type: 'button', className: 'dshup-btn',
                        onClick: () => setState((s0) => ({ ...s0, phase: 'idle' })),
                    }, t('later')),
                    (phase === 'idle' || phase === 'error') && h('button', {
                        key: 'check', type: 'button', className: 'dshup-btn primary', disabled: busy,
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
                ]),
            ]);
        }

        /** 注册设置页卡片。 */
        /** 设置导航项的 label：自带图标 + 文字。
         *  上游导航按 section id 硬编码图标表（未知 id 显示设置齿轮），
         *  而 label 经 resolveSlotLabel 原样透传、React 渲染其返回的节点，
         *  故以节点携带官方图标，并用上方 CSS 隐藏默认齿轮。 */
        function navLabel() {
            return h('span', { className: 'dshup-navwrap' }, [
                h(IconDownload, { className: 'dshup-navicon', key: 'icon' }),
                h('span', { key: 'text' }, '版本更新'),
            ]);
        }

        function apply(ctx) {
            ensureStyle();
            ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: 'updater',
                order: 90,
                label: navLabel,
            }, UpdaterCard));
        }

        module.exports = { name, inject, apply };
        return module.exports;
    },
});
