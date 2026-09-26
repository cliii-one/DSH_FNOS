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

echo "==> [3/4] 准备运行时（使用应用中心 nodejs_v24 依赖，不打包 node 二进制）"
# 采用 manifest install_dep_apps=nodejs_v24 声明系统依赖：
# 1. 安装包体积大幅缩小（不带 100+MB 的 node 二进制）
# 2. Node 版本由应用中心统一管理升级
mkdir -p "${APP_PKG}/bin"

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
# pnpm v10+ 出于安全默认不执行依赖的安装脚本（postinstall 等），
# DSH 的部分依赖（node-pty、koffi 等）需要编译/下载原生产物，安装时被跳过
# 会触发 ERR_PNPM_IGNORED_BUILDS 并以退出码 1 失败。
# 处理：显式声明允许这些依赖跑脚本，再执行安装。
echo "==> pnpm approve-builds（允许 DSH 依赖的安装脚本）"
cat > "${APP_PKG}/pnpm-workspace.yaml" <<EOF
onlyBuiltDependencies:
  - "@deepseek-ai/dsh-subprocess-local"
  - "@google/genai"
  - "koffi"
  - "node-pty"
  - "protobufjs"
EOF
# COREPACK_ENABLE_STRICT=0 防止上游 packageManager 字段触发 corepack 强制切版本
(cd "${APP_PKG}" && COREPACK_ENABLE_STRICT=0 npm_config_arch=arm64 npm_config_target_arch=arm64 "${PNPM_BIN:-pnpm}" install --prod --no-frozen-lockfile)

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
# 原生模块校验：目标平台是 arm64 NAS，
# 必须有 linux-arm64 产物；不能混入 linux-x64 产物（装了也跑不了）
if ! find "${APP_PKG}" -name "*.node" -path "*linux-arm64*" | grep -q .; then
    echo "FATAL: 未找到 linux-arm64 原生模块，arm64 NAS 上无法运行" >&2
    exit 1
fi
if find "${APP_PKG}" -name "*.node" -path "*linux-x64*" | grep -q .; then
    echo "FATAL: 包内混入 linux-x64 原生模块，请检查 npm_config_arch 是否生效" >&2
    find "${APP_PKG}" -name "*.node" -path "*linux-x64*" >&2
    exit 1
fi
echo "    原生模块校验通过（linux-arm64 产物齐全）"

echo "==> 组装完成: ${APP_PKG}"
