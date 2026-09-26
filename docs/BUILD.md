# 构建与发布指南

> 本项目所有构建都在 GitHub Actions 上完成，NAS 本机只负责安装，不占用任何 CPU/内存。

## 前置条件

NAS 端什么都不用装，只需要一个 GitHub 仓库。

## GitHub Actions 自动构建

仓库推到 GitHub 后：

1. **手动触发**：Actions → build → Run workflow（可指定上游 ref、强制发布）
2. **自动触发**：每天 UTC 20:00 检查上游版本，有新版本才构建发布 Release

CI 流程：拉上游 master → `pnpm install && pnpm run build` → `pnpm pack` 出 tgz → 组装应用壳（运行时交给应用中心 nodejs_v24 依赖，不打包 node 二进制）→ 校验包体无原生模块 → `fnpack build` → 发 Release。

产物是跨架构通用的 `DSH_all.fpk`（platform=all，纯 JS 包体）。

### CI 上的 fnpack

工作流从飞牛官方静态地址下载（直接二进制，无需解压）：

```
https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64   # CI（amd64）使用
https://static2.fnnas.com/fnpack/fnpack-1.2.2-linux-arm64   # NAS 本机打包装这个（arm64）
```

若官方出新版，只需改 `.github/workflows/build.yml` 中 `FNPACK_URL` 一行。

## NAS 端安装

```bash
# 方式一：appcenter-cli（SSH）
wget -O /tmp/DSH.fpk https://github.com/<你的用户名>/DSH/releases/latest/download/DSH_all.fpk
appcenter-cli install-fpk /tmp/DSH.fpk

# 方式二：飞牛桌面 → 应用中心 → 手动安装 → 上传 fpk
```

访问方式：飞牛桌面点 DSH 卡片，或浏览器打开 `http://NAS地址/app/dsh`（走统一网关，需登录 NAS）。

## 升级已装应用

新版本 fpk 直接覆盖安装即可；用户数据在应用的 `var/`（HOME=`.dsh` 配置、会话记录）与共享目录（workspace）中，升级不受影响。

## 常见问题

| 现象 | 排查 |
|------|------|
| 启动失败：DSH 本体缺失 | fpk 组装时 tgz 安装失败，看 CI 日志 `pnpm install` 步骤 |
| 启动失败：找不到 Node | 应用中心安装 `nodejs_v24` 运行时 |
| 入口打不开（网关 404） | 确认 `cmd/main status` 运行中；确认 `dsh.sock` 存在于应用 target 目录 |
| 入口打不开（端口模式） | 确认端口未被占用；日志在 `var/DSH.log` |
| 升级后版本没变 | CI 的版本检查跳过了重复发布，手动 Run workflow 勾选 force_release |
