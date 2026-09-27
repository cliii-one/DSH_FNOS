#!/bin/bash
# =============================================================
# DSH 本体升级脚本（在 NAS 本地执行，从 npm 拉取新版）
#
# 设计要点：
#   1. 只替换 node_modules，不动应用壳（bin/runner.js 等）——
#      我们的 fnOS 兼容修复在 runner.js 中，升级不会丢失
#   2. 先停服务再换装：避免"替换正在使用的目录"
#   3. staging 预装 + 原子替换 + 失败回滚：
#      staging 与目标同分区，mv 是原子操作
#   4. 版本来源用 npm 的 next 标签：
#      上游 npm latest 落后于 master（实测 latest=0.1.5-rc.3，
#      next=0.1.7-rc.2），用 latest 会降级
#
# 用法：
#   ./upgrade.sh              # 升级到 next 标签最新版
#   ./upgrade.sh 0.1.7-rc.2   # 升级到指定版本
#   ./upgrade.sh --check      # 只检查是否有新版，不做任何改动
# =============================================================
set -euo pipefail

APP_DIR="/vol2/@appcenter/dsh"
CMD_MAIN="/var/apps/dsh/cmd/main"
NPM_BIN="/var/apps/nodejs_v24/target/bin/npm"
PKG="@deepseek-ai/dsh"
DIST_TAG="next"

STAGING_DIR="${APP_DIR}/.upgrade-staging"
BACKUP_DIR="${APP_DIR}/node_modules.upgrade-bak"

# 参数解析
TARGET_VERSION=""
CHECK_ONLY=0
case "${1:-}" in
    --check) CHECK_ONLY=1 ;;
    "") ;;
    *) TARGET_VERSION="$1" ;;
esac

log() { echo "[升级] $*"; }
die() { echo "[升级] 错误：$*" >&2; exit 1; }

# ---------- 前置检查 ----------
[ -x "${NPM_BIN}" ] || die "找不到 npm（${NPM_BIN}），请确认已安装 nodejs_v24 依赖"
[ -f "${APP_DIR}/node_modules/${PKG}/package.json" ] || die "找不到已安装的 ${PKG}"

CURRENT_VERSION=$(node -p "require('${APP_DIR}/node_modules/${PKG}/package.json').version" 2>/dev/null) \
    || die "读取当前版本失败"

# ---------- 解析目标版本 ----------
if [ -n "${TARGET_VERSION}" ]; then
    WANT_VERSION="${TARGET_VERSION}"
else
    WANT_VERSION=$("${NPM_BIN}" view "${PKG}@${DIST_TAG}" version 2>/dev/null) \
        || die "查询 ${PKG}@${DIST_TAG} 版本失败（检查网络或 registry）"
fi

log "当前版本：${CURRENT_VERSION}"
log "目标版本：${WANT_VERSION}"

if [ "${CURRENT_VERSION}" = "${WANT_VERSION}" ]; then
    log "已是最新版本，无需升级"
    exit 0
fi

if [ "${CHECK_ONLY}" = "1" ]; then
    log "发现新版本：${CURRENT_VERSION} -> ${WANT_VERSION}"
    exit 0
fi

# ---------- 第一步：staging 预装新版 ----------
# 在目标同分区内预装，保证后续 mv 是原子操作
log "正在下载并安装新版到 staging（依赖较多，需数分钟）..."
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
cat > "${STAGING_DIR}/package.json" <<EOF
{
  "name": "dsh-fnos-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "${PKG}": "${WANT_VERSION}"
  }
}
EOF

if ! (cd "${STAGING_DIR}" && "${NPM_BIN}" install --omit=dev --no-audit --no-fund --loglevel=error); then
    rm -rf "${STAGING_DIR}"
    die "下载新版失败，已清理 staging，当前安装未受影响"
fi

# 校验 staging 结果
[ -f "${STAGING_DIR}/node_modules/${PKG}/lib/bin.js" ] \
    || { rm -rf "${STAGING_DIR}"; die "新版缺少 lib/bin.js，安装包不完整"; }
STAGED_VERSION=$(node -p "require('${STAGING_DIR}/node_modules/${PKG}/package.json').version" 2>/dev/null)
[ "${STAGED_VERSION}" = "${WANT_VERSION}" ] \
    || { rm -rf "${STAGING_DIR}"; die "staging 版本(${STAGED_VERSION})与目标(${WANT_VERSION})不一致"; }
log "staging 校验通过（${STAGED_VERSION}）"

# ---------- 第二步：停止服务 ----------
log "正在停止服务..."
"${CMD_MAIN}" stop 2>/dev/null || true
sleep 2

# ---------- 第三步：原子替换 ----------
log "正在替换 node_modules..."
rm -rf "${BACKUP_DIR}"
mv "${APP_DIR}/node_modules" "${BACKUP_DIR}"
if ! mv "${STAGING_DIR}/node_modules" "${APP_DIR}/node_modules"; then
    # 换入失败：还原旧目录，保证系统可用
    log "换入失败，正在回滚..."
    mv "${BACKUP_DIR}" "${APP_DIR}/node_modules"
    rm -rf "${STAGING_DIR}"
    die "替换失败，已回滚到 ${CURRENT_VERSION}"
fi
log "替换完成"

# ---------- 第四步：重启并健康检查 ----------
log "正在启动服务..."
if "${CMD_MAIN}" start; then
    log "服务启动成功"
    rm -rf "${BACKUP_DIR}" "${STAGING_DIR}"
    log "升级完成：${CURRENT_VERSION} -> ${WANT_VERSION}"
    exit 0
fi

# ---------- 第五步：启动失败则回滚 ----------
log "服务启动失败，正在回滚到 ${CURRENT_VERSION}..."
"${CMD_MAIN}" stop 2>/dev/null || true
sleep 1
rm -rf "${APP_DIR}/node_modules.failed"
mv "${APP_DIR}/node_modules" "${APP_DIR}/node_modules.failed"
mv "${BACKUP_DIR}" "${APP_DIR}/node_modules"
rm -rf "${STAGING_DIR}"
if "${CMD_MAIN}" start; then
    log "已回滚并恢复正常运行（失败的新版保留在 node_modules.failed 供排查）"
else
    die "回滚后仍无法启动，请检查日志 /vol2/@appdata/dsh/dsh.log"
fi
exit 1
