# 山月记本地开发

## 环境

- Node.js 与 Corepack
- pnpm 10.33.0
- Docker 或 OrbStack（仅本地 Halo 联调需要）

## 启动主题构建

```bash
corepack pnpm install
corepack pnpm dev
```

Vite 会持续把 `src/` 构建到 Halo 读取的 `templates/`。

## 启动本地 Halo

```bash
docker compose up -d
```

访问 <http://localhost:8090/console> 完成初始化，然后在“外观 → 主题”中安装并启用“山月记”。`compose.yaml` 已关闭 Thymeleaf 缓存，并将当前仓库挂载为 `moonlit-mountain` 开发目录。

修改 `theme.yaml` 或 `settings.yaml` 后，在控制台重载主题配置；已配置 Halo CLI 时也可以运行：

```bash
halo theme reload moonlit-mountain
```

开发期间不要对挂载目录执行主题升级。需要验证发布包时运行：

```bash
corepack pnpm build
```

产物位于 `dist/moonlit-mountain-0.0.1.zip`。

## 可选官方插件

- `PluginMoments` >= 1.16.1：瞬间列表与详情
- `PluginPhotos` >= 2.0.0：图库列表与详情
- `PluginLinks` >= 2.2.1：友链与订阅动态

使用自定义主菜单时，需要在 Halo 菜单管理中显式添加对应路由。插件的内容、分组和分页设置继续由插件自身管理。
