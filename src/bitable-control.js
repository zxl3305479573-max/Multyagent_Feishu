const COMMANDS = new Map([["暂停", "pause"], ["继续", "resume"], ["终止", "terminate"]]);

function responseOf(response, error) {
  if (error) {
    const data = error.response?.data;
    return { ok: false, code: data?.code ?? null, message: data?.msg || error.message || String(error) };
  }
  const code = response?.code ?? 0;
  return { ok: code === 0, code, message: response?.msg || "", data: response?.data };
}

async function call(fn) {
  try { return responseOf(await fn()); }
  catch (error) { return responseOf(null, error); }
}

export function parseControlValue(value) {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object") value = value.name || value.text || "";
  return COMMANDS.get(String(value || "").trim()) || null;
}

function textValue(value) {
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === "object") return value.text || value.name || "";
  return String(value ?? "").trim();
}

export function createBitableControl({
  client,
  appToken,
  tableId,
  onCommand = async () => {},
  log = console,
  intervalMs = Number(process.env.FEISHU_BITABLE_CONTROL_POLL_MS) || 5000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!client || !appToken || !tableId) throw new Error("createBitableControl requires client, appToken and tableId");
  let timer = null;
  let polling = null;
  let stopped = false;

  async function acknowledge(recordId, result) {
    const response = await call(() => client.bitable.appTableRecord.update({
      path: { app_token: appToken, table_id: tableId, record_id: recordId },
      // SingleSelect cells are cleared with an empty option array. Using null
      // is accepted by some mocks but rejected by the Bitable API.
      data: { fields: { "控制指令": [], "控制结果": String(result || "已接收").slice(0, 500) } },
    }));
    if (!response.ok) throw new Error(`command acknowledgement failed: code=${response.code} msg=${response.message}`);
  }

  async function handleRecord(record) {
    const fields = record.fields || {};
    const raw = textValue(fields["控制指令"]);
    if (!raw) return;
    const command = parseControlValue(raw);
    const taskId = textValue(fields["任务编号"]);
    if (!command || !taskId) {
      log.warn?.(`[bitable-control] ignored invalid command record=${record.record_id || "unknown"} task=${taskId || "missing"}`);
      return;
    }
    try {
      const result = await onCommand({ command, taskId, recordId: record.record_id });
      await acknowledge(record.record_id, typeof result === "string" ? result : result?.result);
    } catch (error) {
      log.warn?.(`[bitable-control] command failed task=${taskId} command=${command}: ${error.message}`);
    }
  }

  async function pollOnce() {
    let pageToken;
    do {
      const response = await call(() => client.bitable.appTableRecord.list({
        path: { app_token: appToken, table_id: tableId },
        params: {
          page_size: 500,
          field_names: JSON.stringify(["任务编号", "控制指令"]),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }));
      if (!response.ok) throw new Error(`command list failed: code=${response.code} msg=${response.message}`);
      for (const record of response.data?.items || []) await handleRecord(record);
      pageToken = response.data?.has_more ? response.data?.page_token : null;
    } while (pageToken);
  }

  function poll() {
    if (stopped) return Promise.resolve();
    if (polling) return polling;
    polling = pollOnce().catch((error) => {
      log.warn?.(`[bitable-control] poll failed: ${error.message}`);
    }).finally(() => { polling = null; });
    return polling;
  }

  function start() {
    if (timer || stopped) return;
    void poll();
    timer = setIntervalFn(() => { void poll(); }, intervalMs);
    timer?.unref?.();
  }

  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    await polling;
  }

  return { poll, start, stop, get running() { return Boolean(timer) && !stopped; } };
}
