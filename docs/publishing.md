# 发布与分发

三件事，都是一次性操作：**npm**、**插件目录（awesome-dsh-plugin）**、**GitHub Release**。

## 0. 发布前检查

```bash
node --test                 # 全绿（渲染测试没装 react 会 skip，正常）
npm run check               # 语法
grep -rn "<your-name>" .    # 不应有残留
```

版本号改在两处：`package.json` 的 `version` 与 `CHANGELOG.md` 的新小节。

## 1. 发布到 npm

包名 `dsh-chunk-download`（已确认未被占用；想发到 scope 下就用 `@CXk253-chenxing/dsh-chunk-download`，
并给 `package.json` 加 `"publishConfig": { "access": "public" }`）。

```bash
npm login
npm publish          # prepublishOnly 会自动跑 npm test
```

验证：

```bash
npm view dsh-chunk-download version
npm i -g dsh-chunk-download
```

> 安装到 DSH：`dsh plugin add dsh-chunk-download`（桌面版 CLI）或插件管理里按包名安装。

## 2. 进插件目录（awesome-dsh-plugin）

- 目录仓库：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- 条目位置：`data/plugins/<owner>__<repo>.yml`
- 条目格式（参考仓库里已有文件）：

  ```yaml
  url: https://github.com/<owner>/<repo>
  name: <owner>/<repo>
  category: tools
  description:
    en: ...
    zh: ...
  ```

本仓库已经把条目写好了：[docs/catalog-entry.yml](catalog-entry.yml)。提 PR 时：

```bash
git clone https://github.com/<你的fork>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
cp /path/to/docs/catalog-entry.yml data/plugins/CXk253-chenxing__dsh-chunk-download.yml
git checkout -b add-dsh-chunk-download
git add data/plugins/CXk253-chenxing__dsh-chunk-download.yml
git commit -m "Add CXk253-chenxing/dsh-chunk-download"
git push -u origin add-dsh-chunk-download
# 然后在 GitHub 上开 PR
```

目录站：<https://awesome-dsh-plugin.com>（收录后 `dsh-plugin-catalog` npm 包会带上本条目）。

## 3. GitHub Release

```bash
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1
```

然后 Releases → **Draft a new release** → 选 `v0.2.1`：

- 标题：`v0.2.1`
- 说明：从 `CHANGELOG.md` 复制对应小节
- 附件：`dsh-chunk-download-0.2.1.tgz`（`npm run pack:plugin` 生成）

## 4. 发布后检查清单

- [ ] README 顶部 Release 徽章显示 `v0.2.1`
- [ ] `dsh plugin add dsh-chunk-download` 能装上
- [ ] awesome-dsh-plugin 的条目出现在目录站
- [ ] Release 附件能下载，解包后 `node --test` 通过

## 附：README 要不要配动图

比参数表有用的多。手机上录 10 秒：**标题栏胶囊 → 点开面板 → 文件出现在 Download**，
转成 GIF（< 3 MB）放在 `assets/demo.gif`，README 的「界面」一节替换掉 `ui-mock.svg`。
录制需要手机屏幕录制权限，容器里做不了。
