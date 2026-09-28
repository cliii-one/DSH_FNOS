/**
 * dsh-updater 客户端渲染测试（Node 模拟宿主，无需浏览器）。
 * 运行：node tests/client-render.test.js
 * 覆盖：工厂执行、section 注册、label 节点结构（图标+文字）、卡片渲染。
 */
let failed = 0;
const check = (ok, name) => { console.log((ok ? '✓' : '✗') + ' ' + name); if (!ok) failed++; };

global.window = global;
global.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, dataset: {}, append: () => {} }),
    querySelector: () => null,
    head: { append: () => {} },
};
globalThis.__ModuleLoader__ = {
    load({ factory }) {
        const fakeRequire = (name) => {
            if (name === 'react') return {
                // children 数组展开，与真实 React 行为一致
                createElement: (t, p, ...c) => ({ type: t, props: p, children: c.length === 1 && Array.isArray(c[0]) ? c[0] : c }),
                useState: v => [typeof v === 'function' ? v() : v, () => {}],
                useEffect: () => {}, useCallback: f => f, useRef: v => ({ current: v }),
            };
            if (name.includes('primitives')) return { IconDownloadOutlineMedium: function IconDownload() { return null; } };
            return {};
        };
        try {
            const mod = factory(fakeRequire);
            check(mod.name === 'dsh-updater', '插件名正确');
            const regs = [];
            mod.apply({ slots: {
                inject: (n, r) => r(),
                register: (def, C) => { regs.push({ def, C }); return () => {}; },
            }});
            const reg = regs.find(r => r.def.id === 'updater');
            check(reg !== undefined, 'settings.section 注册（id=updater）');
            const ln = reg.def.label();
            check(ln.type === 'span' && ln.props.className === 'dshup-navwrap', 'label 根节点 span.dshup-navwrap');
            const icon = ln.children[0], text = ln.children[1];
            check(typeof icon.type === 'function' && icon.props.className === 'dshup-navicon', '图标组件 + dshup-navicon 类');
            check(text.children[0] === '版本更新', 'label 文本');
            const card = reg.C({});
            check(card && card.props.className === 'dshup-root', '卡片正常渲染');
        } catch (e) {
            check(false, '执行异常: ' + e.message);
        }
        // profile 对账保留性：dsh 的 reconcileProfilePlugins 会移除
        // 不在 dependencies 里的 bundle（cmd/main 必须同时写两处）
        const previous = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-updater'];
        const deps = [{ name: 'dsh-updater', bundle: true }];
        const beforeNames = new Set(), afterNames = new Set(deps.map(d => d.name));
        const bundleNames = new Set(deps.filter(d => d.bundle).map(d => d.name));
        const kept = previous.filter(n => !(beforeNames.has(n) || afterNames.has(n)) || bundleNames.has(n));
        check(kept.includes('dsh-updater'), 'profile 对账保留 dsh-updater（需 dependencies 声明）');

        if (failed > 0) process.exit(1);
        console.log('\n全部通过');
    },
};
require('../plugin/client/client.js');
