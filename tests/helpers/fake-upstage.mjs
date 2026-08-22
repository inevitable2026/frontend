/**
 * Stateful, network-free fetch fake for Studio v2 contract tests.
 * Endpoint state advances only when a matching request is made.
 */
function asResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function nextState(states, fallback) {
  if (states.length > 1) return states.shift();
  return states[0] ?? fallback;
}

export function createMetricsSink() {
  const records = [];
  return {
    record(record) {
      records.push({ ...record });
    },
    snapshot() {
      return records.map((record) => ({ ...record }));
    },
  };
}

export function createFakeUpstage({
  fileStates = [{ status: 200, body: { status: "ready" } }],
  responseStates = [{ status: 200, body: { status: "completed", output: [] } }],
  deleteStates = [{ status: 204 }],
} = {}) {
  const calls = [];
  const files = new Map();
  const responses = new Map();
  const queue = (values) => values.map((value) => ({ ...value }));
  const state = {
    fileStates: queue(fileStates),
    responseStates: queue(responseStates),
    deleteStates: queue(deleteStates),
  };
  let fileNumber = 0;
  let responseNumber = 0;

  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.search, signal: init.signal ?? null, body: init.body ?? null });

    if (method === "POST" && url.pathname === "/v2/files") {
      const id = `file-${++fileNumber}`;
      files.set(id, { id, deleted: false });
      return asResponse(201, { id });
    }

    const file = url.pathname.match(/^\/v2\/files\/([^/]+)$/);
    if (file) {
      const record = files.get(file[1]);
      if (!record) return asResponse(404, { error: "missing file" });
      if (method === "DELETE") {
        const result = nextState(state.deleteStates, { status: 204 });
        if (result.status >= 200 && result.status < 300) record.deleted = true;
        return asResponse(result.status, result.body);
      }
      if (method === "GET") {
        const result = nextState(state.fileStates, { status: 200, body: { status: "ready" } });
        return asResponse(result.status, result.body);
      }
    }

    if (method === "POST" && url.pathname === "/v2/responses") {
      const id = `response-${++responseNumber}`;
      responses.set(id, { id });
      return asResponse(201, { id });
    }

    const response = url.pathname.match(/^\/v2\/responses\/([^/]+)$/);
    if (response && method === "GET") {
      if (!responses.has(response[1])) return asResponse(404, { error: "missing response" });
      const result = nextState(state.responseStates, { status: 200, body: { status: "completed", output: [] } });
      return asResponse(result.status, result.body);
    }

    return asResponse(404, { error: `Unhandled ${method} ${url.pathname}` });
  };

  return {
    fetch,
    calls: () => calls.map((call) => ({ ...call })),
    file: (id) => files.get(id),
    response: (id) => responses.get(id),
  };
}
