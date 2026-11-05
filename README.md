# dsh-nai-draw

给 **dsh-go 手机 App** 用的本地生图插件：输入框写一句描述，点「画图」胶囊出图；模型也能通过 `nai_draw` 工具按剧情配图。后端是 OpenAI 兼容格式的 NovelAI 4.5 中转站。

不是 Cordis bundle，不是网页插件——它装在 `$DSH_HOME/dsh-go/plugins/` 下，在手机原生界面里长胶囊和面板。

## 功能

| 位置 | 是什么 |
| --- | --- |
| 输入框上方胶囊「画图」 | 把输入框里的草稿画成一张图 |
| 工具 `nai_draw` | 模型按描述/剧情调用，参数：`prompt` `size` `steps` `rating` |
| 面板「作品」 | 最近 24 张，点开看大图 |
| 面板「预设」 | 点一行切换画师串（prompt 前缀），下一张生效 |
| 面板「设置」 | 模型 / 尺寸 / 步数 / 分级 / 自动配图 / 预设 / Key 状态，一行一下切换 |

另外注册一条 system prompt section（`local-nai-draw-director`，order 521），教模型怎么写 prompt：先定人物与动作、景别、光线，再按 danbooru 顺序拼 tag，不写质量词和画师串（插件统一补）。

## 安装

```sh
git clone https://github.com/cchh3297433176-hub/dsh-nai-draw.git
P="${DSH_HOME:-$HOME/.dsh}/dsh-go/plugins/local-nai-draw"
mkdir -p "$(dirname "$P")" && cp -r dsh-nai-draw "$P"
dsh plugin --profile web add "$P"
```

装上即生效，不用重启。改 `package.json`（清单）会自动重读；改 `lib/` 里的代码要重启引擎。

卸载：`dsh plugin --profile web remove local-nai-draw`，再删目录。

装之前可以自查（会真的加载宿主半侧、画一遍所有视图）：

```sh
node "${DSH_HOME:-$HOME/.dsh}/skills/dsh-go-plugin/kit/bin/check.mjs" "$P" --load
```

本仓库这份在 dsh-go 1.0.10 上跑过 `--load`，能加载、三个面板都能显示，`nai_draw` 注册成功（只剩主题强调色的对比度提示，不是代码问题）。

## 首次配置

复制 `data/settings.example.json` 成 `data/settings.json`（这个文件不进仓库），填 `key`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `key` | 空 | 中转站 API Key，`sk-sb-…`。空的时候出图直接报「还没配 Key」 |
| `model` | `nai-diffusion-4-5-curated` | 另一张是 `nai-diffusion-4-5-full` |
| `size` | `832x1216` | 可选 `1216x832` `1024x1024` |
| `steps` | `28` | 设置面板在 28 / 20 / 14 之间循环 |
| `sampler` | `k_euler_ancestral` | |
| `rating` | `off` | `general` 会追加 `rating:general` 锁全年龄 |
| `activeArtist` | `u1` | 指向 `data/presets.json` 里某个预设 |
| `autoDraw` | `false` | 开 = 在提示词里加「每轮最多画一张」 |
| `baseUrl` | 见下 | 覆盖接口地址，必须是 OpenAI 兼容的 `/v1` 根路径 |

接口地址默认 `https://xiaowanzi.top/nai/api/openai/v1`（作者自己的腾讯云反代，因为手机直连中转站约六成 TCP 被丢），失败会自动回退直连 `https://create.suanbohe.com/api/openai/v1`。想完全走直连，把 `baseUrl` 设成直连地址即可。

## 一次出图发生了什么

1. 合参数：`settings.json` ← 工具参数 / 预设里的 `size` `steps` 覆盖。
2. 拼 prompt：`预设 prompt + 用户草稿 + 质量词`（预设自带 `quality` 优先，否则用模型默认质量词；`rating:general` 追加在最后）。
3. 先 `GET /models` 预热连接（每次 5 s 上限，退避 300/700/1200/2000/3000/4000 ms），再发 `POST /images/generations`（单次 150 s 上限）。
4. 拿 `data[0].url` 下载，校验长度 > 2 KiB 且前两字节是 PNG 魔数，否则算失败重试。
5. 存 `assets/gen/<毫秒时间戳>-<seed>.png`，同 id 写一份 `.json` 元数据（prompt/model/seed/参数）。
6. 超过 1 MiB 就调 python3 + Pillow 转 WebP（逐级降 scale 和 quality 直到压到 1 MB 内）。
7. 工具卡另外生成一张 192 px、≤ 4.2 KB 的 WebP data URL 内嵌进去（见「硬限制」）。
8. 返回 `stack` 视图：图片 + 模型/尺寸/步数/画师串/种子。

## 硬限制（都是踩过的坑，改之前先看）

- **插件资源走 `GET /dsh-go/v1/assets/<pkg>/<path>`，超过 1 MiB 直接 404**，App 里就是一张破图。所以生成的图必须压在 1 MiB 以下，Pillow 不可用时退回原 PNG（那就会破图）。
- **工具卡有 8 KiB 预算**，而且卡片里取不到 `asset:` 资源。所以卡片用 192 px、≤ 4.2 KB 的内嵌 `data:image/webp;base64` 缩略图，完整图在回复正文和作品面板里。
- **中转站会丢 TCP**：所以是「短超时预热 + 多次重试 + 反代兜底」三层，不要改成一次长请求。
- 4xx/5xx 是服务器明确回答，**不重试**；只有网络层错误才重试。
- Pillow 是可选的：没有它也能出图，只是大图压不下去、工具卡没有缩略图。

## 依赖

- 运行在 dsh-go 引擎里（node 20+），只用 `node:` 内置模块，无 npm 依赖。
- 可选：`python3` + `Pillow`（WebP 压缩和缩略图）。

## 目录

```
package.json          dshGo 清单（胶囊 / 面板 / 资源目录）+ dsh.bundle 指向 patch
cordis.patch.yml      把自己 insert 进 profile
lib/index.js          全部逻辑（约 520 行，无构建步骤）
data/presets.json     画师串预设（id / name / prompt / quality / negative / size? / steps?）
data/settings.example.json
assets/gen/           生成的图 + 元数据，不进仓库
```

## 已知不足（接手的话先挑这里改）

- **Key 没有输入口**：设置面板只显示「已配置/未配置」，只能手改 `data/settings.json`。想加 UI 得用 App 的输入事件，动作里目前没有可写文本的通道。
- **`autoDraw` 改完要重启引擎**：system prompt section 在 `apply` 时读一次 `settings.json`，之后不再刷新。
- 只能「画一张」，没有同 seed 重画、没有收藏、没有删除单张。
- 重试次数、超时、退避间隔都是写死的常量，没有暴露给设置。
- 并发只有胶囊那条路有 `busy` 标志；工具调用之间没有互斥，连发两张会同时打中转站。
- `presets.json` 只能在文件里改，App 里不能增删。
- 面板文案中文硬编码，`en` 只覆盖了清单里的 title/label。

## 安全与隐私

- 仓库里**没有 Key**，`data/settings.json` 在 `.gitignore` 里；`assets/gen/` 也不入库。
- 默认接口地址是作者自己的反代，只做转发、不落盘图片；不想用就把 `baseUrl` 换成直连或你自己的反代。
- 出图内容分级默认 `off`（不限制），需要全年龄就把 `rating` 设成 `general` 或在面板里锁上。

## License

MIT
