**标题：** fix(runtime): 数据文件损坏时隔离备份，不再导致 runtime 无法启动

## 问题

`JsonStore.load()` 读取 `dataDir` 下的 `settings.json` / `topics.json` / `messages.json` 等文件时，只要有一个文件不是合法 JSON 就会直接抛错，整个 runtime 启动失败，桌面端表现为一直连不上 `127.0.0.1:17890`。

截断的文件是可能出现的：`writeJson` 在 Windows 上 rename 连续重试失败（EPERM / EBUSY，常见于杀毒软件或索引服务占用文件）后会退回直接覆盖目标文件，这一步不是原子的，进程在这时被杀就会留下半截 JSON。

## 改动

- 新增 `readJsonFile()`：文件不存在或内容为空时按缺失处理；`JSON.parse` 抛出 `SyntaxError` 时，把原文件改名为 `<file>.corrupt-<时间戳>` 保留下来，并用 `console.error` 输出备份路径，然后按空值继续（数组文件为 `[]`，`settings.json` 使用默认设置）。
- 合法 JSON 但不符合 zod schema 的情况**仍然抛错**，不会因此掩盖 schema 或迁移方面的 bug。
- 空白的 `settings.json` 现在等同于不存在（以前会因为 `JSON.parse("")` 报错）。
- 顺手把 `unlink` 的动态 import 改成了顶部静态 import。

## 测试

`packages/runtime/src/store/json-store.test.ts` 新增 4 个用例：

- 数组文件损坏 → 加载为空、原文件被改名、备份内容与原文件一致
- `settings.json` 损坏 → 使用默认设置并生成备份
- `settings.json` 为空白 → 使用默认设置，不生成备份
- 合法 JSON 但 schema 不符 → 仍然抛错，文件保持原样

`pnpm --filter @ml-aos/runtime test`：150 个通过，1 个失败。失败的是 `settings-service.test.ts` 的 “returns default settings and patches theme”：测试期望默认主题是 `dark`，代码默认值是 `warm`。这个失败在 main 上就存在，和本 PR 无关。`tsc --noEmit` 报的 36 个错误也都是 main 上已有的，数量没有变化。

## 后续可选

`writeJson` 中非原子的直接写回退仍然保留。是否改成重试失败就报错（宁可丢掉这一次写入，也不写出半截文件），可以另开 PR 讨论。
