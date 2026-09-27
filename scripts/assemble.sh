#!/bin/bash
# =============================================================
# DSH 组装脚本：把上游构建产物装进 fnOS 应用壳，产出待打包目录
# 仅供 GitHub Actions 调用（本机 Arm 性能不足，构建全部放在 CI 上）
#
# fnOS 应用包结构规范（fnpack 要求）：
#   包根目录/
#   ├── manifest           → 应用元数据（安装框架读取）
#   ├── cmd/               → 生命周期脚本
#   ├── config/            → privilege + resource
#   ├── wizard/            → 安装向导
#   ├── ICON*.PNG          → 图标
#   └── app/               → ★ 应用运行内容：打包为 app.tgz，
#       安装后解压到 TRIM_APPDEST（即 /var/apps/<app>/target/）
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
# 应用运行内容目录：fnpack 打包为 app.tgz，安装后即 TRIM_APPDEST
APP_CONTENT="${APP_PKG}/app"

echo "==> [1/4] 清理并创建组装目录"
rm -rf "${STAGE_DIR}"
mkdir -p "${APP_PKG}" "${APP_CONTENT}"

echo "==> [2/4] 复制应用壳（manifest/cmd/config/wizard/ui/图标）"
# ui/ 需要同时存在于两处（对照可正常安装的社区 fpk）：
#   ① 包根 ui/ → 安装器读取桌面入口配置（ui/config 的 port 等）
#   ② app/ui/  → fnpack 打包 app.tgz 时要求该路径存在，
#                缺失会报 "stat app/ui: no such file or directory" 导致打包失败
cp "${REPO_ROOT}/appshell/manifest" "${APP_PKG}/"
cp -r "${REPO_ROOT}/appshell/cmd" "${APP_PKG}/"
cp -r "${REPO_ROOT}/appshell/config" "${APP_PKG}/"
cp -r "${REPO_ROOT}/appshell/wizard" "${APP_PKG}/"
cp -r "${REPO_ROOT}/appshell/ui" "${APP_PKG}/"
cp -r "${REPO_ROOT}/appshell/ui" "${APP_CONTENT}/"
cp "${REPO_ROOT}/appshell/ICON.PNG" "${REPO_ROOT}/appshell/ICON_256.PNG" "${APP_PKG}/"

echo "==> [3/4] 准备运行时（使用应用中心 nodejs_v24 依赖，不打包 node 二进制）"
# 采用 manifest install_dep_apps=nodejs_v24 声明系统依赖：
# 1. 安装包体积大幅缩小（不带 100+MB 的 node 二进制）
# 2. Node 版本由应用中心统一管理升级
mkdir -p "${APP_CONTENT}/bin"

# DSH 本体：上游是 pnpm monorepo，直接整库安装不可行；
# 先在 CI 上 pack 成 tgz，再在应用内容目录内以 file: 方式装入
if [ -z "${DSH_TGZ:-}" ] || [ ! -f "${DSH_TGZ}" ]; then
    echo "FATAL: 未设置 DSH_TGZ 或文件不存在（CI 需先 pnpm pack 上游包）" >&2
    exit 1
fi
echo "    从 tgz 安装: ${DSH_TGZ}"
# 生成 package.json，依赖指向本地 tgz
cat > "${APP_CONTENT}/package.json" <<EOF
{
  "name": "dsh-fnos-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "file:${DSH_TGZ}"
  }
}
EOF
# 用 npm 安装（扁平无软链）：飞牛安装器对含软链的包会报
# "设置目录权限失败"，npm 的扁平布局可规避；安装后仍会做软链清理兜底。
echo "==> npm 版本: $(npm --version 2>/dev/null || echo N/A)"
set +e
(cd "${APP_CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
INSTALL_EXIT=$?
set -e
if [ ${INSTALL_EXIT} -ne 0 ]; then
    echo "FATAL: npm install 失败 (exit ${INSTALL_EXIT})" >&2
    exit ${INSTALL_EXIT}
fi

# runner.js：自研运行器
cp "${REPO_ROOT}/runner/runner.js" "${APP_CONTENT}/bin/runner.js"
chmod +x "${APP_CONTENT}/bin/runner.js"

# 内置更新插件 dsh-updater：随包进入应用 node_modules。
# dsh 的 bundle 解析顺序是「应用安装目录优先，其次 profile 目录」，
# 因此放在这里即可被 profile 声明引用，无需运行期 pnpm 安装。
# 注意：必须放在 npm install 之后，否则会被后续安装流程覆盖。
echo "==> 内置更新插件 dsh-updater"
UPDATER_DEST="${APP_CONTENT}/node_modules/dsh-updater"
rm -rf "${UPDATER_DEST}"
mkdir -p "${UPDATER_DEST}"
cp -r "${REPO_ROOT}/plugin/lib" "${UPDATER_DEST}/"
cp -r "${REPO_ROOT}/plugin/client" "${UPDATER_DEST}/"
cp "${REPO_ROOT}/plugin/package.json" "${REPO_ROOT}/plugin/cordis.patch.yml" "${UPDATER_DEST}/"
[ -f "${UPDATER_DEST}/lib/install.mjs" ] || { echo "FATAL: 更新插件缺少 install.mjs" >&2; exit 1; }

# 符号链接清理（关键）：
# 飞牛安装器的 ApplyPermission 会递归遍历包内文件，遇到无法解析的软链
# 会直接报 ErrCodeInstallDirAuthException(10234)「设置目录权限失败」。
# 处理策略：断链一律删除；有效软链实体化为真实文件，彻底规避该问题。
# 运行器直接调用 node 执行 bin.js，不依赖 node_modules/.bin 中的软链。
echo "==> 清理符号链接（断链删除 / 有效实体化）"
BROKEN=0
RESOLVED=0
while IFS= read -r link; do
    [ -z "${link}" ] && continue
    if [ -e "${link}" ]; then
        # 有效软链：替换为实体副本（-a 保留目标内容与可执行位）
        target=$(readlink -f "${link}")
        rm -f "${link}"
        cp -a "${target}" "${link}"
        RESOLVED=$((RESOLVED + 1))
    else
        # 断链：直接删除（对运行无意义，且会导致安装失败）
        rm -f "${link}"
        BROKEN=$((BROKEN + 1))
    fi
done < <(find "${APP_CONTENT}" -type l 2>/dev/null)
echo "    实体化有效软链: ${RESOLVED} 个；删除断链: ${BROKEN} 个"
REMAIN=$(find "${APP_CONTENT}" -type l 2>/dev/null | wc -l)
if [ "${REMAIN}" -gt 0 ]; then
    echo "FATAL: 仍残留 ${REMAIN} 个软链，安装器可能报权限失败" >&2
    find "${APP_CONTENT}" -type l >&2
    exit 1
fi

# 统一文件权限：安装器需要可读可执行（对照社区 fpk 的 755/644 规范）
find "${APP_CONTENT}" -type d -exec chmod 755 {} + 2>/dev/null || true
find "${APP_CONTENT}" -type f -exec chmod 644 {} + 2>/dev/null || true
chmod -R 755 "${APP_CONTENT}/bin" 2>/dev/null || true

echo "==> [4/4] 校验组装结果"
if [ ! -d "${APP_CONTENT}/node_modules/@deepseek-ai/dsh" ]; then
    echo "FATAL: @deepseek-ai/dsh 未装入 ${APP_CONTENT}/node_modules" >&2
    exit 1
fi
if [ ! -f "${APP_CONTENT}/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
    echo "FATAL: dsh/lib/bin.js 不存在，构建产物不完整" >&2
    exit 1
fi
# 原生模块校验：arm64 运行器上原生安装，产物应为 linux-arm64
# 必须有 linux-arm64 产物；除 node-pty 自带的全平台 prebuilds 外不得有 linux-x64 产物
if ! find "${APP_CONTENT}" -name "*.node" -path "*linux-arm64*" | grep -q .; then
    echo "FATAL: 未找到 linux-arm64 原生模块，arm64 NAS 上无法运行" >&2
    exit 1
fi
if find "${APP_CONTENT}" -name "*.node" -path "*linux-x64*" | grep -v "node-pty" | grep -q .; then
    echo "FATAL: 包内混入 linux-x64 原生模块，请检查运行器架构" >&2
    find "${APP_CONTENT}" -name "*.node" -path "*linux-x64*" | grep -v "node-pty" >&2
    exit 1
fi
echo "    原生模块校验通过（linux-arm64 产物齐全）"

echo "==> 组装完成: ${APP_PKG}（应用内容在 ${APP_CONTENT}）"
