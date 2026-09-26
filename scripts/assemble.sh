#!/bin/bash
# =============================================================
# DSH 组装脚本：把上游构建产物装进 fnOS 应用壳，产出待打包目录
# 供 GitHub Actions 与本地 build-local.sh 共用
#
# 前置条件（CI 环境已备好）：
#   - 已 clone 上游仓库并完成构建（产物在 $UPSTREAM_DIR）
#   - 本脚本所在仓库已 checkout（应用壳在 appshell/）
#
# 产出：$STAGE_DIR/  —— fnpack 可直接打包的完整应用目录
# =============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${UPSTREAM_DIR:?请设置 UPSTREAM_DIR 为上游 deepseek-harness 仓库根目录}"
STAGE_DIR="${STAGE_DIR:?请设置 STAGE_DIR 为组装输出目录}"
# 上游构建出的版本号，用于写入 manifest
DSH_VERSION="${DSH_VERSION:-0.0.0-dev}"

APP_PKG="${STAGE_DIR}/DSH"

echo "==> [1/4] 清理并创建组装目录"
rm -rf "${STAGE_DIR}"
mkdir -p "${APP_PKG}"

echo "==> [2/4] 复制应用壳（manifest/cmd/config/wizard/ui/图标）"
cp -r "${REPO_ROOT}/appshell/." "${APP_PKG}/"

echo "==> [3/4] 复制上游 DSH 构建产物"
# node 二进制：优先用上游 prepare 脚本产出的 primary runtime，
# 没有（例如纯 CI 构建）则用 CI 容器自带的 node，保证 arm64 匹配
mkdir -p "${APP_PKG}/bin"
if [ -d "${UPSTREAM_DIR}/node-runtime" ]; then
    cp -r "${UPSTREAM_DIR}/node-runtime/." "${APP_PKG}/bin/"
else
    cp "$(command -v node)" "${APP_PKG}/bin/node"
fi
chmod +x "${APP_PKG}/bin/node"

# DSH 本体：上游是 pnpm monorepo，直接整库安装不可行；
# 采用官方推荐的单包安装方式 —— 在应用根目录 package.json 声明依赖，
# 由 pnpm 从本地构建出的 npm registry（或上游已 publish 的版本）安装。
# CI 场景：先把上游 pack 成 tgz，再装入应用目录。
if [ -n "${DSH_TGZ:-}" ] && [ -f "${DSH_TGZ}" ]; then
    echo "    从本地 tgz 安装: ${DSH_TGZ}"
    (cd "${APP_PKG}" && "${PNPM_BIN:-pnpm}" install --prod --no-frozen-lockfile)
else
    echo "    从 npm registry 安装 @deepseek-ai/dsh@${DSH_VERSION}"
    cat > "${APP_PKG}/package.json" <<EOF
{
  "name": "dsh-fnos-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "^${DSH_VERSION}"
  }
}
EOF
    (cd "${APP_PKG}" && "${PNPM_BIN:-pnpm}" install --prod --no-frozen-lockfile)
fi

# runner.js：自研运行器
cp "${REPO_ROOT}/runner/runner.js" "${APP_PKG}/bin/runner.js"
chmod +x "${APP_PKG}/bin/runner.js"

echo "==> [4/4] 校验组装结果"
if [ ! -d "${APP_PKG}/node_modules/@deepseek-ai/dsh" ]; then
    echo "FATAL: @deepseek-ai/dsh 未装入 ${APP_PKG}/node_modules" >&2
    exit 1
fi
if [ ! -f "${APP_PKG}/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
    echo "FATAL: dsh/lib/bin.js 不存在，构建产物不完整" >&2
    exit 1
fi

echo "==> 组装完成: ${APP_PKG}"
