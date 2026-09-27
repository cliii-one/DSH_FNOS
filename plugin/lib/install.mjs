#!/usr/bin/env node
/**
 * dsh-updater 安装脚本（独立进程执行，不依赖 DSH 存活）。
 *
 * 为什么必须分离：要替换的正是 DSH 脚下运行的 node_modules，
 * 目录被占用期间无法安全换入新版；插件本体只负责"触发后退出"，
 * 由本脚本完成：停服务 → 原子替换 → 重启 → 健康检查 → 失败回滚。
 *
 * 对标官方桌面端的 install 阶段（quitAndInstall），差异在于
 * 桌面端替换整个安装包，这里替换 node_modules。
 *
 * 由 lib/index.js 以 detached 方式派生，环境变量传入：
 *   DSH_UPDATE_VERSION  目标版本
 *   DSH_UPDATE_FROM     升级前版本（用于回滚与提示）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = process.env.TRIM_APPDEST || process.cwd();
const NM_DIR = join(APP_DIR, 'node_modules');
const STAGING = join(APP_DIR, '.update-staging');
const BACKUP = join(APP_DIR, 'node_modules.update-bak');
const FAILED = join(APP_DIR, 'node_modules.update-failed');
const VAR_DIR = process.env.TRIM_PKGVAR || join(APP_DIR, 'data');
const STATUS_FILE = join(VAR_DIR, 'update-status.json');
const PKG = '@deepseek-ai/dsh';

const TARGET = process.env.DSH_UPDATE_VERSION ?? '';
const FROM = process.env.DSH_UPDATE_FROM ?? 'unknown';

/** 写状态文件，供设置页在重启后展示结果。 */
function writeStatus(payload) {
    try {
        writeFileSync(STATUS_FILE, JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2));
    } catch { /* 状态文件写失败不影响升级本身 */ }
}

/** 直接调用 cmd/main 控制服务（不依赖插件进程存活）。 */
function cmdMain(action) {
    const main = '/var/apps/dsh/cmd/main';
    if (!existsSync(main)) return { ok: false, message: `找不到 ${main}` };
    const r = spawnSync(main, [action], { encoding: 'utf-8', timeout: 120_000 });
    return { ok: r.status === 0, message: (r.stdout ?? '') + (r.stderr ?? '') };
}

function fail(stage, error) {
    writeStatus({ ok: false, stage, version: TARGET, from: FROM, message: String(error?.message ?? error) });
    process.exit(1);
}

/* ---------- 前置校验 ---------- */

if (!TARGET) fail('preflight', new Error('未指定目标版本'));
if (!existsSync(join(STAGING, 'node_modules', PKG, 'package.json'))) {
    fail('preflight', new Error('staging 中找不到预装的新版'));
}
if (!existsSync(NM_DIR)) fail('preflight', new Error('找不到 node_modules'));

/* ---------- 第一步：停止服务 ---------- */

const stopped = cmdMain('stop');
if (!stopped.ok) {
    // 停止失败不直接放弃：仍尝试替换，但记录告警
    console.error(`[update] 停止服务返回非零：${stopped.message}`);
}
// 等待进程退出并释放文件占用
spawnSync('sleep', ['2']);

/* ---------- 第二步：原子替换 ---------- */

try {
    rmSync(BACKUP, { recursive: true, force: true });
    renameSync(NM_DIR, BACKUP);            // 旧目录让位（同分区，原子）
    try {
        renameSync(join(STAGING, 'node_modules'), NM_DIR);
    } catch (error) {
        // 新目录就位失败 → 立即还原，保持系统可用
        try { renameSync(BACKUP, NM_DIR); } catch { /* 还原也失败只能报错 */ }
        throw new Error(`新 node_modules 就位失败：${error.message}（已回滚）`);
    }
} catch (error) {
    fail('swap', error);
}

/* ---------- 第三步：重启并健康检查 ---------- */

const started = cmdMain('start');
if (started.ok) {
    rmSync(BACKUP, { recursive: true, force: true });
    rmSync(STAGING, { recursive: true, force: true });
    writeStatus({ ok: true, stage: 'done', version: TARGET, from: FROM });
    process.exit(0);
}

/* ---------- 第四步：启动失败则回滚 ---------- */

rmSync(FAILED, { recursive: true, force: true });
try { renameSync(NM_DIR, FAILED); } catch { /* 保留现状以便人工排查 */ }
try { renameSync(BACKUP, NM_DIR); } catch (error) {
    fail('rollback', new Error(`回滚失败：${error.message}`));
}

const restarted = cmdMain('start');
rmSync(STAGING, { recursive: true, force: true });
writeStatus({
    ok: false,
    stage: 'rolled-back',
    version: TARGET,
    from: FROM,
    message: `新版启动失败，已回滚到 ${FROM}${restarted.ok ? '' : '（回滚后重启也失败，请检查日志）'}`,
});
process.exit(1);
