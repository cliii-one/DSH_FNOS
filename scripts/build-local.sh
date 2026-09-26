#!/bin/bash
# =============================================================
# DSH 本机一键构建脚本（在 fnOS 或任意 Linux 上运行）
# 流程：拉上游源码 -> pnpm 构建 -> pack 成 tgz -> 组装 -> fnpack 打包
# 产物：dist/DSH_<arch>.fpk
#
# 用法：./scripts/build-local.sh [--skip-build] [--use-npm-latest]
#   --skip-build     跳过上游构建，直接用 npm 上最新已发布版本
#   --use-npm-latest 不拉源码，直接用 npm 上最新已发布版本
# =============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${REPO_ROOT}/.assemble"
DIST_DIR="${REPO_ROOT}/dist"
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness.git"

SKIP_BUILD=0
USE_NPM=0
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        --use-npm-latest) USE_NPM=1 ;;
    esac
done

mkdir -p "${WORK_DIR}" "${DIST_DIR}"

# ---------- 第一步：获取上游源码 ----------
cd "${WORK_DIR}"
if [ ! -d upstream/.git ]; then
    echo "==> 克隆上游仓库（master 分支）"
    git clone --depth 1 "${UPSTREAM_URL}" upstream
else
    echo "==> 更新上游仓库"
    (cd upstream && git fetch --depth 1 origin master && git reset --hard FETCH_HEAD)
fi

cd upstream
DSH_VERSION=$(node -p "require('./package.json').version")
echo "==> 上游版本: ${DSH_VERSION}"

# ---------- 第二步：构建（或跳过用 npm 版） ----------
if [ "${USE_NPM}" = "1" ]; then
    echo "==> 跳过源码构建，使用 npm 最新版"
else
    if [ "${SKIP_BUILD}" = "1" ]; then
        echo "==> 跳过构建（--skip-build），假定上次构建产物仍有效"
    else
        echo "==> 安装依赖（pnpm install）"
        pnpm install
        echo "==> 构建上游（pnpm run build）"
        pnpm run build
    fi
fi

# ---------- 第三步：pack 出 tgz（CI 与本地一致的传递方式） ----------
echo "==> 打包 @deepseek-ai/dsh 为 tgz"
if [ "${USE_NPM}" = "1" ]; then
    # npm 上直接拉最新版
    DSH_TGZ=$(npm pack @deepseek-ai/dsh@latest --pack-destination "${WORK_DIR}" | tail -1)
    DSH_TGZ="${WORK_DIR}/${DSH_TGZ}"
else
    DSH_TGZ=$(pnpm --filter @deepseek-ai/dsh pack --pack-destination "${WORK_DIR}" | tail -1)
    DSH_TGZ="${WORK_DIR}/${DSH_TGZ}"
fi
echo "    tgz: ${DSH_TGZ}"

# ---------- 第四步：组装应用目录 ----------
echo "==> 组装应用目录"
UPSTREAM_DIR="${WORK_DIR}/upstream" \
STAGE_DIR="${WORK_DIR}/stage" \
DSH_VERSION="${DSH_VERSION}" \
DSH_TGZ="${DSH_TGZ}" \
    "${REPO_ROOT}/scripts/assemble.sh"

# assemble.sh 会执行 pnpm install 装入 tgz 依赖；
# tgz 安装方式需要先把 package.json 写成 file: 引用，补一下
APP_PKG="${WORK_DIR}/stage/DSH"
if [ -n "${DSH_TGZ:-}" ] && [ -f "${DSH_TGZ}" ]; then
    node -e '
        const fs = require("fs");
        const tgz = process.argv[1];
        const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
        pkg.dependencies = { "@deepseek-ai/dsh": "file:" + tgz };
        fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
        console.log("package.json -> file:" + tgz);
    ' "${DSH_TGZ}" "${APP_PKG}/package.json"
    (cd "${APP_PKG}" && pnpm install --prod --no-frozen-lockfile)
fi

# ---------- 第五步：fnpack 打包 ----------
echo "==> fnpack 打包"
if ! command -v fnpack >/dev/null 2>&1; then
    echo "FATAL: 未找到 fnpack，请先安装：https://developer.fnnas.com 下载 fnpack 并加入 PATH" >&2
    exit 1
fi
(cd "${APP_PKG}" && fnpack build)

# 找出产物并挪到 dist/
FPK=$(find "${APP_PKG}" -maxdepth 1 -name "*.fpk" | head -1)
[ -z "${FPK}" ] && { echo "FATAL: 未找到 fpk 产物" >&2; exit 1; }
ARCH=$(uname -m)
case "${ARCH}" in
    x86_64) ARCH_TAG="x86_64" ;;
    aarch64|arm64) ARCH_TAG="arm64" ;;
    *) ARCH_TAG="${ARCH}" ;;
esac
OUT="${DIST_DIR}/DSH_${ARCH_TAG}.fpk"
mv -f "${FPK}" "${OUT}"
echo ""
echo "=========================================="
echo "  构建完成: ${OUT}"
echo "=========================================="
