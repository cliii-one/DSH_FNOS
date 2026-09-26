#!/bin/bash
# =============================================================
# DSH 组装脚本：把上游构建产物装进 fnOS 应用壳，产出待打包目录
# 仅供 GitHub Actions 调用（本机 Arm 性能不足，构建全部放在 CI 上）
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
# node 二进制：CI 跑在 x64 上，但 NAS 是 arm64，
# 所以这里必须下载官方 arm64 版 Node，直接拷 CI 的 node 会无法运行
mkdir -p "${APP_PKG}/bin"
NODE_VERSION="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")')"
NODE_ARCH="arm64"
echo "    下载 Node v${NODE_VERSION} (${NODE_ARCH})..."
curl -sL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
tar -xJf /tmp/node.tar.xz -C /tmp
cp /tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node "${APP_PKG}/bin/node"
rm -rf /tmp/node.tar.xz /tmp/node-v${NODE_VERSION}-linux-${NODE_ARCH}
chmod +x "${APP_PKG}/bin/node"

# DSH 本体：上游是 pnpm monorepo，直接整库安装不可行；
# 先在 CI 上 pack 成 tgz，再在应用目录内以 file: 方式装入
if [ -z "${DSH_TGZ:-}" ] || [ ! -f "${DSH_TGZ}" ]; then
    echo "FATAL: 未设置 DSH_TGZ 或文件不存在（CI 需先 pnpm pack 上游包）" >&2
    exit 1
fi
echo "    从 tgz 安装: ${DSH_TGZ}"
# 生成 package.json，依赖指向本地 tgz
cat > "${APP_PKG}/package.json" <<EOF
{
  "name": "dsh-fnos-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "file:${DSH_TGZ}"
  }
}
EOF
(cd "${APP_PKG}" && "${PNPM_BIN:-pnpm}" install --prod --no-frozen-lockfile)

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
