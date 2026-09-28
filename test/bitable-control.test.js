import test from "node:test";
import assert from "node:assert/strict";
import { createBitableControl, parseControlValue } from "../src/bitable-control.js";

function makeClient(pages = []) {
  const calls = { list: [], update: [] };
  const client = {
    bitable: { appTableRecord: {
      list: async (args) => {
        calls.list.push(args);
        if (pages.fail) return { code: 1254000, msg: "offline" };
        return pages.shift() || { code: 0, data: { items: [] } };
      },
      update: async (args) => { calls.update.push(args); return { code: 0, data: {} }; },
    } },
  };
  return { client, calls };
}

test("parseControlValue accepts only exact supported choices from Feishu cell shapes", () => {
  assert.equal(parseControlValue("暂停"), "pause");
  assert.equal(parseControlValue([{ name: "继续" }]), "resume");
  assert.equal(parseControlValue({ name: "终止" }), "terminate");
  assert.equal(parseControlValue("请继续"), null);
  assert.equal(parseControlValue(""), null);
});

test("poll applies commands page by page and clears only the one-shot command field", async () => {
  const pages = [
    { code: 0, data: { items: [{ record_id: "r1", fields: { "任务编号": "T-1", "控制指令": [{ name: "暂停" }], "控制结果": "old" } }], has_more: true, page_token: "next" } },
    { code: 0, data: { items: [{ record_id: "r2", fields: { "任务编号": "T-2", "控制指令": "终止", "任务": "keep" } }], has_more: false } },
  ];
  const { client, calls } = makeClient(pages);
  const applied = [];
  const control = createBitableControl({ client, appToken: "base", tableId: "board", onCommand: async (command) => {
    applied.push(command);
    return { result: `${command.command} 已接收` };
  } });
  await control.poll();
  assert.deepEqual(applied.map((item) => [item.taskId, item.command]), [["T-1", "pause"], ["T-2", "terminate"]]);
  assert.equal(calls.list.length, 2);
  assert.equal(calls.list[1].params.page_token, "next");
  assert.deepEqual(calls.update.map((item) => item.data.fields), [
    { "控制指令": [], "控制结果": "pause 已接收" },
    { "控制指令": [], "控制结果": "terminate 已接收" },
  ]);
});

test("acknowledgement clears a single-select control cell with an explicit empty value", async () => {
  const { client, calls } = makeClient([{ code: 0, data: { items: [{ record_id: "r1", fields: { "任务编号": "T-1", "控制指令": [{ name: "暂停" }] } }] } }]);
  const control = createBitableControl({ client, appToken: "base", tableId: "board", onCommand: async () => "已暂停" });
  await control.poll();
  assert.deepEqual(calls.update[0].data.fields, { "控制指令": [], "控制结果": "已暂停" });
});

test("failed command handlers leave the command in Bitable for a safe retry", async () => {
  const { client, calls } = makeClient([{ code: 0, data: { items: [{ record_id: "r1", fields: { "任务编号": "T-1", "控制指令": "继续" } }] } }]);
  const control = createBitableControl({ client, appToken: "base", tableId: "board", onCommand: async () => { throw new Error("not ready"); }, log: { warn() {}, error() {} } });
  await control.poll();
  assert.equal(calls.update.length, 0);
});

test("unknown commands are reported but never acknowledged or erased", async () => {
  const warnings = [];
  const { client, calls } = makeClient([{ code: 0, data: { items: [{ record_id: "r1", fields: { "任务编号": "T-1", "控制指令": "继续一下" } }] } }]);
  const control = createBitableControl({ client, appToken: "base", tableId: "board", onCommand: async () => assert.fail("unknown command must not be invoked"), log: { warn: (line) => warnings.push(line), error() {} } });
  await control.poll();
  assert.equal(calls.update.length, 0);
  assert.equal(warnings.length, 1);
});
