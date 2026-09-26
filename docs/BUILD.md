# 构建与发布指南

## 前置条件

| 工具 | 版本 | 用途 |
|------|------|------|
| Node.js | ≥ 22.19 或 ≥ 24 | 构建上游 + 运行 DSH |
| pnpm | 11.x | 上游 monorepo 依赖管理 |
| git | 任意 | 拉取上游源码 |
| fnpack | 最新 | fnOS `.fpk` 打包（[下载](https://developer.fnnas.com)） |

## 本地构建（在 fnOS 上）

```bash
cd /vol2/1000/05-DeepSeek/DSH
./scripts/build-local.sh
```

全流程：克隆/更新上游 master → `pnpm install && pnpm run build` → `pnpm pack` 出 tgz → 组装应用壳 → `fnpack build` 出 `dist/DSH_arm64.fpk`。

只想要最新 npm 发布版（不自己构建源码）：

```bash
./scripts/build-local.sh --use-npm-latest
```

## GitHub Actions 自动构建

仓库推到 GitHub 后：

1. **手动触发**：Actions → build → Run workflow（可指定上游 ref、强制发布）
2. **自动触发**：每天 UTC 20:00 检查上游版本，有新版本才构建发布 Release

### CI 上的 fnpack

工作流从 `https://download.fnnas.com/fnpack/fnpack-linux-x64.zip` 下载 fnpack。
若官方地址变化，修改 `.github/workflows/build.yml` 中 `curl -sL -o /tmp/fnpack.zip` 那一行的 URL。

## NAS 端安装

```bash
# 方式一：appcenter-cli（SSH）
wget -O /tmp/DSH.fpk https://github.com/<你的用户名>/DSH/releases/latest/download/DSH_arm64.fpk
appcenter-cli install-fpk /tmp/DSH.fpk

# 方式二：飞牛桌面 → 应用中心 → 手动安装 → 上传 fpk
```

## 升级已装应用

新版本 fpk 直接覆盖安装即可；用户数据在应用的 `var/`（HOME=`.dsh` 配置、会话记录）与共享目录（workspace）中，升级不受影响。

## 常见问题

| 现象 | 排查 |
|------|------|
| 启动失败：DSH 本体缺失 | fpk 组装时 tgz 安装失败，看 CI 日志 `pnpm install` 步骤 |
| 端口被占用 | 应用设置中改 `wizard_port`，或停掉占用方 |
| 入口打不开 | 确认 `cmd/main status` 运行中；日志在 `var/DSH.log` |
| 升级后版本没变 | CI 的版本检查跳过了重复发布，手动 Run workflow 勾选 force_release |
