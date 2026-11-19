# commonjs：Rollup 5 import attributes 支持的设计取舍

## 背景

Rollup 5 把 import attributes 当作模块身份的一部分。同一个文件按不同 attributes 导入，会得到不同的模块，id 为 `<rawId>?attributes=<编码后的 JSON>`。如果 rawId 本身已经带 `?`，则拼成 `&attributes=`。`load`、`transform`、`shouldTransformCachedModule` 会额外收到 `rawId`，`resolveId` 会额外收到 `importerRawId`。

commonjs 插件用 `?commonjs-es-import`、`?commonjs-entry` 等后缀标记自己的代理模块，并用 `endsWith` 识别这些后缀。在 Rollup 5 下，`&attributes=...` 被接在这些后缀后面，导致：

```
Could not load \0…/c.js?commonjs-es-import&attributes=%7B%22foo%22%3A%22bar%22%7D
```

同样的导入在 Rollup 4 上正常。

## 核心原则：判断用 rawId，身份用完整 id

| 用途                                                   | 用哪个                                  | 例子                                                                                                           |
| ------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 识别插件自己的后缀、判断扩展名、路径处理、用户选项匹配 | `rawId`                                 | `isWrappedId`、`isPossibleCjsId`、`strictRequiresFilter`、`getDefaultIsModuleExports`、`dynamicRequireModules` |
| 指向某个具体的模块实例                                 | 完整 `id`，或者 `{ rawId, attributes }` | `this.getModuleInfo`、`this.load`、`requireResolver` 里按 id 记录的状态                                        |

每处都按 `(options && options.rawId) || id` 取 rawId，和其他插件的分支写法一致。Rollup 4 没有 `rawId`，于是退回 `id`，行为不变。

## 取舍 1：带 attributes 的 ES 导入得到独立的 CJS 实例

`import x from './c.js' with { foo: 'bar' }` 和 `require('./c.js')` 指向同一个文件，但最后是两个模块实例：

- ES 导入得到 `c.js?attributes=...`，它是带 attributes 的实例。
- `require()` 不会带 attributes，得到普通的 `c.js`。

**选这个的理由**

- 和 Rollup 5 对 ES 模块的规则一致：attributes 不同就是不同的模块。
- 其他插件可能会根据 attributes 改写模块内容，所以 attributes 必须一路传到真正被加载的那个实例。
- `resolveId` 里本来就要用 `this.load` 分析目标模块是不是 CJS、是否需要包装。分析的必须是之后真正会被导入的那个实例，否则判断依据和实际打包的模块对不上。

**代价**

- 同一个文件既被带 attributes 导入，又被 `require()` 或者以不带 attributes 的方式导入时，代码会打包两份，`module.exports` 也是两个对象，不共享状态。对 CJS 来说这可能出乎意料，但这是 Rollup 5 模块身份规则的直接结果，只有带 attributes 的导入才会触发。
- 实测例子：`c.js` 为 `module.exports = { v: 1 };`，`main.js` 里同时写 `import a from './c.js' with { foo: 'bar' }` 和 `import b from './c.js'`。在 Rollup 4.64.5 上，产物里只有一份模块体；在 rollup@5.0.0-1 上有两份。

**否掉的方案**：让代理忽略 attributes，统一指向普通实例。这样只有一个实例，但 attributes 会被悄悄丢掉。`resolveId` 里分析的实例也会和最后导入的实例不一致。

## 取舍 2：代理模块带着相同的 attributes 导入目标

ES import 代理（`?commonjs-es-import`）和 entry 代理（`?commonjs-entry`）都是由插件生成代码，再去 `import` 真正的模块。为了让代理和目标成对，代理生成的导入语句会带上同样的 attributes：

```js
import { __require as requireC } from "/abs/c.js" with {"foo":"bar"};
```

- `load` 从 `loadOptions.attributes` 拿到代理自己的 attributes。只有 `rawId !== id`，也就是 attributes 确实编码进了 id 时，才往下传（`idAttributes`）。Rollup 4 虽然也会传 `attributes`，但它们不是模块身份的一部分，所以不往下传，Rollup 4 的输出和以前完全一样。
- `getEntryProxy`、`getEsImportProxy` 新增 `attributes` 参数，由 `getImportSource` 生成 `"id" with {...}`。
- `getEntryProxy` 改为直接接收目标的 `moduleInfo`，不再接收 `getModuleInfo` 函数，因为调用方查询时必须带上 attributes。
- `resolveId` 返回两种代理时都显式携带最终的 `resolved.attributes`，包括其他解析插件添加、覆盖或移除 attributes 的情况。

## 取舍 3：直接把解析结果传给 `this.load`

Rollup 5 的 #6653 已修复 `this.load` 对 attributes 的处理。`this.resolve` 仍然返回 rawId 形式的 `id`，但 `this.load` 会把它和单独的 `attributes` 字段组合成模块身份。因此 `resolve-id.js` 直接调用 `this.load(resolved)`，不再需要 `getLoadableResolvedId` 或大版本号判断，Rollup 4 也使用相同的调用方式。

ES import 代理也直接调用 `this.load({ id: actualId, attributes: idAttributes })`。entry 代理的 `this.getModuleInfo` 仍需要 `{ rawId, attributes }`，因为它没有单独的 attributes 参数。

对于已编码 attributes 的完整 id，`this.load` 会校验单独传入的 attributes 是否一致；不一致时抛出 `CONFLICTING_MODULE_ATTRIBUTES`。缓存解析结果可以继续直接传入，不需要额外转换。

ES import 的扩展名回退也把当前导入的 attributes 放进解析结果，确保预加载分析和实际导入使用同一个模块实例。

ES import 代理 resolve 出来之后，`meta.commonjs.resolved.id` 记录的是 `moduleInfo.id`，也就是完整 id。这样 `shouldTransformCachedModule` 等按 id 查找的地方，找到的是同一个实例。

## 其他改动

- `resolveId`：用 `importerRawId` 判断导入方是不是插件自己的代理。导入方是带 attributes 的代理时，`importer` 后面会拼着 `&attributes=...`。
- `shouldTransformCachedModule`：用 `rawId` 识别 ES import 代理。`resolvedSources` 里的条目优先用 `rawId` 判断后缀。
- 本分支不扩展 `require()` 的 attributes 支持，现有 require 行为保持不变。

## 测试

当前 npm 的 Rollup beta 为 `5.0.0-2`，还不包含 #6653。开发依赖暂时用 `link:../../../rollup` 连接同级 Rollup 仓库；该仓库需切到包含修复的 `rollup-5` 分支并构建 Node 产物。修复发布后，应将这个本地链接换成对应的 npm 版本。peer 范围已加入 `^5.0.0`。

直接运行 `pnpm --filter @rollup/plugin-commonjs test` 和 `pnpm --filter @rollup/plugin-commonjs test:ts`，无需额外设置 `NODE_OPTIONS`。

新增 15 个测试，覆盖以下场景：

- preserves import attributes in CommonJS proxies across cached builds
- uses resolved import attributes when a resolver adds, overrides or removes them（3 个用例）
- uses resolved import attributes in CommonJS entry proxies（strictRequires 为 true、false 的 2 个用例）
- preserves import attributes when resolving configured extensions
- transforms CommonJS modules imported with import attributes
- analyzes the module instance with the same import attributes when resolving ES imports
- does not resolve again imports from ES import proxies with import attributes
- imports the module with the same import attributes from ES import proxies
- imports the module with the same import attributes from entry proxies
- ignores import attributes in proxies when they are not part of the module id
- does not re-transform cached ES import proxies with import attributes
- re-transforms cached importers of a module with import attributes that is no longer wrapped

完整测试套件使用 Rollup 5，7 个集成用例直接运行，输出快照以 Rollup 5 为准。日志断言检查插件自己的消息和错误码。CommonJS 套件 306 个测试以及类型测试全部通过。

## 待定

- 本文件只用于说明设计，开 PR 前应该删掉，内容放进 PR 描述。
