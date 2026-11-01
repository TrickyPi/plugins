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

## 取舍 3：`this.load(resolved)` 在 Rollup 5 下要手动转换

Rollup 5 里 `this.resolve` 返回的是一次解析结果：`id` 实际上是 rawId，attributes 放在单独的字段里。`this.load` 接收的则是模块身份：字符串会被当作完整 id。所以直接写 `this.load(resolved)`，会悄悄加载不带 attributes 的那个实例。

因此 `resolve-id.js` 里加了 `getLoadableResolvedId`：

```js
parseInt(rollupVersion, 10) >= 5
  ? { ...resolved, id: { rawId: resolved.id, attributes: resolved.attributes } }
  : resolved;
```

- **为什么判断版本号**：Rollup 4 的 `this.load` 不接受对象形式的 id，而这个能力没法做特性检测，只能看 `this.meta.rollupVersion`。
- **代价**：插件和 Rollup 的大版本号耦合在一起。
- **和上游的关系**：这是 Rollup 5 API 的一个缺口。Rollup 文档里"可以直接把 `this.resolve` 的返回值传给 `this.load`"这句话是从 Rollup 4 沿用下来的。上游讨论倾向于这样处理：

  - `this.resolve` 和 `this.load` 的签名都不改；
  - 修改文档，要求先转换成 `{ rawId, attributes }`；
  - `this.load` 收到"未编码的字符串 id 加上非空 `attributes`"时报错。

  按这个方案，这里的写法不用改。如果上游改成让 `this.resolve` 同时返回 `id`、`rawId`、`attributes` 三个字段，这里就要改为用 `resolved.rawId` 拼代理 id，`getLoadableResolvedId` 也可以删掉。

ES import 代理 resolve 出来之后，`meta.commonjs.resolved.id` 记录的是 `moduleInfo.id`，也就是完整 id。这样 `shouldTransformCachedModule` 等按 id 查找的地方，找到的是同一个实例。

## 其他改动

- `resolveId`：用 `importerRawId` 判断导入方是不是插件自己的代理。导入方是带 attributes 的代理时，`importer` 后面会拼着 `&attributes=...`。
- `shouldTransformCachedModule`：用 `rawId` 识别 ES import 代理。`resolvedSources` 里的条目优先用 `rawId` 判断后缀。
- `requireResolver.isRequiredId(id)` 仍然用完整 id。带 attributes 的实例永远不会被 `require()` 到，结果是正确的。

## 测试

新增 8 个测试，在未修改的 master 上都会失败：

- transforms CommonJS modules imported with import attributes
- analyzes the module instance with the same import attributes when resolving ES imports
- does not resolve again imports from ES import proxies with import attributes
- imports the module with the same import attributes from ES import proxies
- imports the module with the same import attributes from entry proxies
- ignores import attributes in proxies when they are not part of the module id
- does not re-transform cached ES import proxies with import attributes
- re-transforms cached importers of a module with import attributes that is no longer wrapped

完整测试套件全部通过。在 rollup@5.0.0-1 上，带 attributes 导入 CJS 模块能正常打包；在 Rollup 4 上，输出和改之前一字不差。

## 待定

- 取舍 3 依赖上游怎么修 `this.load(this.resolve())` 的缺口，Rollup 5 正式版之前需要再确认一次。
- 本文件只用于说明设计，开 PR 前应该删掉，内容放进 PR 描述。
