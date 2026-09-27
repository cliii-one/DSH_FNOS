# 构建与发布指南

> 本项目所有构建都在 GitHub Actions 上完成，NAS 本机只负责安装，不占用任何 CPU/内存。

## 前置条件

NAS 端什么都不用装，只需要一个 GitHub 仓库。

## GitHub Actions 自动构建

推送代码到 master 即触发构建；也可手动触发或等待每日定时检查：

| 触发方式 | 说明 |
|----------|------|
| push 到 master | 自动构建（文档类改动除外，已配置 paths-ignore） |
| 手动触发 | Actions → build → Run workflow，可指定上游 ref、强制发布 |
| 定时任务 | 每天 UTC 20:00 检查上游版本，有新版才构建发布 |

定时任务保留「版本未变则跳过」的检查；push 与手动触发始终重新构建，
以便应用壳代码变更后能重新出包。

### CI 流程

1. Checkout 本仓库与上游 deepseek-harness（默认 master 分支）
2. 读取上游 `package.json` 版本号
3. `pnpm install` + `pnpm run build` 构建上游
4. `pnpm --filter @deepseek-ai/dsh pack` 打出 tgz
5. 运行 `scripts/assemble.sh` 组装应用目录：
   - 复制应用壳（manifest / cmd / config / wizard / ui / 图标）
   - 在 `app/` 内以 `file:` 方式 `npm install` 安装 DSH 本体（扁平无软链）
   - 清理软链、统一文件权限（安装器要求）
   - 校验 DSH 本体与 arm64 原生模块齐全
6. `fnpack build` 打包
7. 上传 artifact 并发布 GitHub Release（已存在则覆盖更新资产）

### 运行器与产物

CI 使用 **arm64 原生运行器**（`ubuntu-24.04-arm`），依赖的原生模块按 arm64 安装，
与目标 NAS 架构一致。

产物为 `DSH_v<上游版本>_all.fpk`（`platform=all`）。运行时由应用中心
`nodejs_v24` 依赖提供，包内不含 Node 二进制。

### CI 上的 fnpack

工作流从飞牛官方静态地址下载 fnpack（直接二进制，无需解压）：

```
https://static2.fnnas.com/fnpack/fnpack-1.2.1-linux-arm64
```

若官方出新版，只需改 `.github/workflows/build.yml` 中 `FNPACK_URL` 一行。

## NAS 端安装

```bash
# 方式一：appcenter-cli（SSH）
wget -O /tmp/DSH.fpk https://github.com/<你的用户名>/DSH_FNOS/releases/latest/download/DSH_v0.1.7-rc.2_all.fpk
sudo appcenter-cli install-fpk /tmp/DSH.fpk

# 方式二：飞牛桌面 → 应用中心 → 手动安装 → 上传 fpk
```

访问方式：飞牛桌面点 DSH 卡片，或浏览器打开 `http://NAS地址:3082`。

## 升级

有两种方式，按需选择：

### 方式一：就地升级 DSH 本体（推荐，无需重新打包）

应用内已带升级脚本，在 NAS 上以**应用用户**执行：

```bash
sudo -u dsh /var/apps/dsh/cmd/main upgrade --check   # 仅检查是否有新版
sudo -u dsh /var/apps/dsh/cmd/main upgrade           # 升级到 npm next 最新版
sudo -u dsh /var/apps/dsh/cmd/main upgrade <版本号>   # 升级到指定版本
```

只替换 `node_modules`，应用壳（`bin/`）不动，配置与工作区不受影响。
失败会自动回滚到升级前版本。

**权限要求**：应用内容目录属主为应用用户 `dsh`（775），服务也以该用户运行。
以 root 执行会让新装的 `node_modules` 变成 `root:root`，导致服务无法读写而
启动失败。脚本检测到 root 身份时会自动降权到应用用户，无需手工处理。

### 方式二：覆盖安装新 fpk

仅在**应用壳本身有变更**时才需要（如 manifest、cmd 脚本、图标、
runner.js 改动）。新版本 fpk 直接覆盖安装即可，用户数据在共享目录
`/vol2/@appshare/dsh`（含 `.dsh` 配置与 `Documents` 工作区），升级不受影响。

## 常见问题

| 现象 | 排查 |
|------|------|
| 安装失败：设置目录权限失败 | 包内含软链或断链，检查 CI 组装日志的软链清理输出 |
| 安装失败：打包阶段报 app/ui 不存在 | `ui/` 需同时存在于包根与 `app/` 内（assemble.sh 已处理） |
| 启动失败：DSH 本体缺失 | fpk 组装时 npm 安装失败，看 CI 的组装步骤日志 |
| 启动失败：找不到 Node | 应用中心安装 `nodejs_v24` 运行时 |
| 启动失败：端口被占用 | 应用设置中更换端口（默认 3082） |
| 入口打不开 | 确认 `cmd/main status` 运行中；日志在 `/vol2/@appdata/dsh/dsh.log` |
| 无法创建默认工作区 | 需设置 `XDG_DOCUMENTS_DIR`（cmd/main 已处理），使 `xdg-user-dir DOCUMENTS` 不返回 HOME |
| 升级后版本没变 | 定时任务会跳过已发布版本，手动 Run workflow 勾选 force_release |
