import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeUpstage,
  createMetricsSink,
} from "./helpers/fake-upstage.mjs";
import {
  runStudioWorkflow,
  StudioError,
} from "../tmp/test-dist/lib/context/studio.js";

const KIND = "기타";
const identity = {
  agentId: "agent-1",
  agentName: "sitectx-gatea-20260822-general",
  role: "일반 문서 판독",
  capabilityReceiptId: "receipt-1",
  manifestSha: "manifest-sha",
  configFingerprint: "config-sha",
  configId: "config-1",
  servedIdentity: "agent-1",
  servedIdentityField: "model",
  requestFields: { config_id: "config-1" },
};

function workflowOutput() {
  const fieldCoordinates = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.2 },
    { x: 0.1, y: 0.2 },
  ];
  return {
    id: "response-1",
    status: "completed",
    model: "agent-1",
    output: [
      {
        model: "parse",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              api: "document-parse",
              elements: [
                {
                  id: 0,
                  page: 1,
                  category: "paragraph",
                  coordinates: fieldCoordinates,
                  content: { text: "현장 참고 문서" },
                },
              ],
              content: { text: "현장 참고 문서" },
              usage: { pages: 1 },
              model: "document-parse",
            }),
          },
        ],
      },
      {
        model: "extract_기타",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              kind: KIND,
              schema_version: "studio-document-envelope/v1",
              현장명: "강남 업무시설",
              공종: [],
              장비: [],
              자재: [],
              문서유형: "참고 문서",
              요약: "현장 참고 문서",
            }),
            additional_values: JSON.stringify({
              previous_step_name: "parse",
              step_run_id: "redacted-step",
              occurrence_id: "redacted-occurrence",
              job_execution_id: "redacted-job",
              cache_hit: false,
              현장명: {
                _value: "강남 업무시설",
                confidence: 0.99,
                confidence_score: 0.99,
                page: 1,
                coordinates: fieldCoordinates,
              },
              문서유형: {
                _value: "참고 문서",
                confidence: 0.98,
                confidence_score: 0.98,
                page: 1,
                coordinates: fieldCoordinates,
              },
              요약: {
                _value: "현장 참고 문서",
                confidence: 0.98,
                confidence_score: 0.98,
                page: 1,
                coordinates: fieldCoordinates,
              },
            }),
          },
        ],
      },
    ],
  };
}

function parallelCollectionWorkflow(
  kind,
  fields,
  locationKeys,
  withCoordinates = true,
) {
  const fieldCoordinates = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.3 },
    { x: 0.1, y: 0.3 },
  ];
  return {
    id: `response-${kind}`,
    status: "completed",
    model: "agent-1",
    output: [
      {
        model: "parse",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              api: "document-parse",
              elements: [
                {
                  id: 0,
                  page: 1,
                  category: "table",
                  coordinates: fieldCoordinates,
                  content: { text: "현장 작업 기록" },
                },
              ],
              content: { text: "현장 작업 기록" },
              usage: { pages: 1 },
              model: "document-parse",
            }),
          },
        ],
      },
      {
        model: `extract_${kind}`,
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              kind,
              schema_version: "studio-document-envelope/v1",
              공종: [],
              장비: [],
              자재: [],
              ...fields,
            }),
            additional_values: JSON.stringify({
              previous_step_name: "parse",
              step_run_id: "redacted-step",
              cache_hit: false,
              ...(withCoordinates
                ? Object.fromEntries(
                    locationKeys.map((key) => [
                      key,
                      fields[key].map((value) => ({
                        _value: value,
                        confidence: 0.96,
                        page: 1,
                        coordinates: fieldCoordinates,
                      })),
                    ]),
                  )
                : {}),
            }),
          },
        ],
      },
    ],
  };
}

test("returns a processing conflict before a file becomes ready", async () => {
  const server = createFakeUpstage({
    fileStates: [
      { status: 409, body: { status: "processing" } },
      { status: 200, body: { status: "ready" } },
    ],
  });
  const signal = new AbortController().signal;
  const uploaded = await server.fetch("https://api.upstage.ai/v2/files", {
    method: "POST",
    signal,
  });
  const { id } = await uploaded.json();

  assert.equal(
    (await server.fetch(`https://api.upstage.ai/v2/files/${id}`, { signal }))
      .status,
    409,
  );
  assert.deepEqual(
    await (
      await server.fetch(`https://api.upstage.ai/v2/files/${id}`, { signal })
    ).json(),
    { status: "ready" },
  );
  assert.ok(server.calls().every((call) => call.signal === signal));
});

test("returns a configured malformed completed response unchanged", async () => {
  const server = createFakeUpstage({
    responseStates: [
      { status: 200, body: { status: "completed", output: [{ content: [] }] } },
    ],
  });
  const created = await server.fetch("https://api.upstage.ai/v2/responses", {
    method: "POST",
  });
  const { id } = await created.json();

  assert.deepEqual(
    await (
      await server.fetch(`https://api.upstage.ai/v2/responses/${id}`)
    ).json(),
    {
      status: "completed",
      output: [{ content: [] }],
    },
  );
});

test("records remote deletion only after a successful cleanup attempt", async () => {
  const server = createFakeUpstage({
    deleteStates: [{ status: 503 }, { status: 204 }],
  });
  const uploaded = await server.fetch("https://api.upstage.ai/v2/files", {
    method: "POST",
  });
  const { id } = await uploaded.json();

  assert.equal(
    (
      await server.fetch(`https://api.upstage.ai/v2/files/${id}`, {
        method: "DELETE",
      })
    ).status,
    503,
  );
  assert.equal(server.file(id).deleted, false);
  assert.equal(
    (
      await server.fetch(`https://api.upstage.ai/v2/files/${id}`, {
        method: "DELETE",
      })
    ).status,
    204,
  );
  assert.equal(server.file(id).deleted, true);
});

test("keeps concurrent metric collectors isolated", async () => {
  const first = createMetricsSink();
  const second = createMetricsSink();
  await Promise.all([
    Promise.resolve().then(() =>
      first.record({ operation: "files", attempts: 2 }),
    ),
    Promise.resolve().then(() =>
      second.record({ operation: "responses", attempts: 1 }),
    ),
  ]);

  assert.deepEqual(first.snapshot(), [{ operation: "files", attempts: 2 }]);
  assert.deepEqual(second.snapshot(), [
    { operation: "responses", attempts: 1 },
  ]);
});

test("runs the real two-step Studio response, enriches evidence, and deletes the remote file", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: workflowOutput() }],
  });
  const result = await runStudioWorkflow(
    KIND,
    new Uint8Array([1, 2, 3]),
    "synthetic.pdf",
    "application/pdf",
    {
      deadline: Date.now() + 10_000,
      cleanupDeadline: Date.now() + 20_000,
      identity,
      fetch: server.fetch,
      sleep: async () => {},
    },
  );

  assert.equal(result.cleanup.status, "deleted");
  assert.equal(server.file(result.fileId).deleted, true);
  assert.equal(result.provenance.responseId, "response-1");
  assert.equal(result.provenance.requestedConfigId, "config-1");
  assert.deepEqual(result.provenance.boundByReceipt, { id: "receipt-1", scheme: "request-config-id-v1" });
  assert.equal(result.provenance.servedConfigEchoVerified, false);
  assert.equal(result.provenance.servedIdentity, "agent-1");
  assert.equal("configId" in result.provenance, false);
  assert.deepEqual(result.provenance.stepNames, ["parse", "extract_기타"]);
  assert.equal(result.validation.raw.owner, "application");
  assert.equal(result.review.raw.owner, "application");
  assert.match(result.extracted.evidence[0].evidenceId, /^[a-f0-9]{64}$/);
  assert.equal(result.extracted.evidence[0].responseId, "response-1");
  assert.equal(result.extracted.현장명, "강남 업무시설");
  assert.equal(result.extracted.evidence[0].elementId, "0");
  assert.deepEqual(
    [
      ...new Set(result.extracted.evidence.map((anchor) => anchor.sourceKey)),
    ].sort(),
    ["문서유형", "요약", "현장명"],
  );
  assert.equal(
    server.calls().filter((call) => call.path === "/v2/responses").length,
    1,
  );
  assert.ok(
    server
      .calls()
      .some(
        (call) =>
          call.path === "/v2/responses/response-1" &&
          call.search.includes("include"),
      ),
  );
});

test("accepts the documented status-less Upstage file metadata response as ready", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    fileStates: [
      {
        status: 200,
        body: {
          id: "file-1",
          object: "file",
          bytes: 3,
          created_at: 1_724_321_234,
          expires_at: null,
          purpose: "user_data",
        },
      },
    ],
    responseStates: [{ status: 200, body: workflowOutput() }],
  });

  const result = await runStudioWorkflow(
    KIND,
    new Uint8Array([1, 2, 3]),
    "synthetic.pdf",
    "application/pdf",
    {
      deadline: Date.now() + 10_000,
      cleanupDeadline: Date.now() + 20_000,
      identity,
      fetch: server.fetch,
      sleep: async () => {},
    },
  );

  assert.equal(result.fileId, "file-1");
  assert.equal(
    server
      .calls()
      .filter(
        (call) => call.path === "/v2/files/file-1" && call.method === "GET",
      ).length,
    1,
  );
  assert.equal(
    server
      .calls()
      .filter((call) => call.path === "/v2/responses" && call.method === "POST")
      .length,
    1,
  );
});

test("derives evidence from Extract field metadata by deterministic Parse-coordinate overlap", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const output = workflowOutput();
  const parse = output.output.find((step) => step.model === "parse");
  parse.content[0].text = JSON.stringify({
    elements: [
      {
        id: 0,
        page: 1,
        category: "paragraph",
        coordinates: [
          { x: 0.05, y: 0.05 },
          { x: 0.95, y: 0.05 },
          { x: 0.95, y: 0.25 },
          { x: 0.05, y: 0.25 },
        ],
        content: { text: "현장 참고 문서" },
      },
      {
        id: 1,
        page: 1,
        category: "paragraph",
        coordinates: [
          { x: 0.7, y: 0.7 },
          { x: 0.9, y: 0.7 },
          { x: 0.9, y: 0.8 },
          { x: 0.7, y: 0.8 },
        ],
        content: { text: "무관한 문장" },
      },
    ],
    content: { text: "현장 참고 문서\n무관한 문장" },
  });
  const extract = output.output.find((step) => step.model === "extract_기타");
  const metadata = JSON.parse(extract.content[0].additional_values);
  const innerCoordinates = [
    { x: 0.1, y: 0.1 },
    { x: 0.4, y: 0.1 },
    { x: 0.4, y: 0.2 },
    { x: 0.1, y: 0.2 },
  ];
  for (const key of ["현장명", "문서유형", "요약"])
    metadata[key].coordinates = innerCoordinates;
  extract.content[0].additional_values = JSON.stringify(metadata);
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: output }],
  });

  const result = await runStudioWorkflow(
    KIND,
    new Uint8Array([1]),
    "synthetic.pdf",
    "application/pdf",
    {
      deadline: Date.now() + 10_000,
      cleanupDeadline: Date.now() + 20_000,
      identity,
      fetch: server.fetch,
      sleep: async () => {},
    },
  );

  assert.deepEqual(
    [...new Set(result.extracted.evidence.map((anchor) => anchor.elementId))],
    ["0"],
  );
});

test("reassembles located primitive work-step columns by index", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const output = parallelCollectionWorkflow(
    "작업표준",
    {
      업체명: "",
      작업명: null,
      보호구: [],
      작업단계ID: ["step-1"],
      작업순서: ["1"],
      작업단계명: ["자재 반입"],
      작업단계위험요인: [""],
      작업단계통제조치: ["[]"],
      작업단계보호구: ["[]"],
    },
    [
      "작업단계ID",
      "작업순서",
      "작업단계명",
      "작업단계위험요인",
      "작업단계통제조치",
      "작업단계보호구",
    ],
  );
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: output }],
  });
  const result = await runStudioWorkflow(
    "작업표준",
    new Uint8Array([1]),
    "work.pdf",
    "application/pdf",
    {
      deadline: Date.now() + 10_000,
      cleanupDeadline: Date.now() + 20_000,
      identity,
      fetch: server.fetch,
      sleep: async () => {},
    },
  );

  assert.equal(result.extracted.작업단계[0].order, 1);
  assert.equal(result.extracted.업체명, null);
  assert.equal(
    result.extracted.작업단계[0].evidence[0].sourceKey,
    "작업단계ID",
  );
  assert.equal(result.extracted.작업단계[0].evidence[0].elementId, "0");
});

test("reassembles risk and patrol rows from individually located primitive columns", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const cases = [
    [
      "위험성평가표",
      [
        "평가항목ID",
        "위험요인",
        "위험도",
        "평가항목저감조치IDs",
        "저감조치ID",
        "저감조치평가항목IDs",
        "저감조치내용",
        "저감조치상태",
      ],
      {
        평가항목ID: ["risk-1"],
        위험요인: ["낙하"],
        위험도: [""],
        평가항목저감조치IDs: ['["mit-1"]'],
        저감조치ID: ["mit-1"],
        저감조치평가항목IDs: ['["risk-1"]'],
        저감조치내용: ["난간 설치"],
        저감조치상태: [""],
      },
      "평가항목ID",
    ],
    [
      "순회점검일지",
      [
        "지적사항ID",
        "지적내용",
        "지적심각도",
        "지적사항조치IDs",
        "조치사항ID",
        "조치사항지적IDs",
        "조치내용",
        "조치상태",
        "조치기한",
      ],
      {
        점검일자: null,
        지적사항ID: ["finding-1"],
        지적내용: ["통로 적치"],
        지적심각도: [""],
        지적사항조치IDs: ['["action-1"]'],
        조치사항ID: ["action-1"],
        조치사항지적IDs: ['["finding-1"]'],
        조치내용: ["즉시 정리"],
        조치상태: [""],
        조치기한: [""],
      },
      "지적사항ID",
    ],
  ];
  for (const [kind, locationKeys, fields, firstSourceKey] of cases) {
    const output = parallelCollectionWorkflow(kind, fields, locationKeys);
    const server = createFakeUpstage({
      responseStates: [{ status: 200, body: output }],
    });
    const result = await runStudioWorkflow(
      kind,
      new Uint8Array([1]),
      "nested.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    );
    const items =
      kind === "위험성평가표"
        ? result.extracted.평가항목
        : result.extracted.지적사항;
    assert.equal(items[0].evidence[0].sourceKey, firstSourceKey);
  }
});

test("rejects reassembled nested rows that lack native primitive coordinate metadata", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const output = parallelCollectionWorkflow(
    "작업표준",
    {
      작업명: null,
      보호구: [],
      작업단계ID: ["step-1"],
      작업순서: ["1"],
      작업단계명: ["자재 반입"],
      작업단계위험요인: [""],
      작업단계통제조치: ["[]"],
      작업단계보호구: ["[]"],
    },
    [
      "작업단계ID",
      "작업순서",
      "작업단계명",
      "작업단계위험요인",
      "작업단계통제조치",
      "작업단계보호구",
    ],
    false,
  );
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: output }],
  });
  await assert.rejects(
    runStudioWorkflow(
      "작업표준",
      new Uint8Array([1]),
      "work.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
    (error) =>
      error instanceof StudioError &&
      error.code === "ACCEPTED_CLAIM_MISSING_EVIDENCE",
  );
});

test("durably checkpoints Studio IDs before subsequent upstream work", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: workflowOutput() }],
  });
  const checkpoints = [];
  await runStudioWorkflow(
    KIND,
    new Uint8Array([1]),
    "synthetic.pdf",
    "application/pdf",
    {
      deadline: Date.now() + 10_000,
      cleanupDeadline: Date.now() + 20_000,
      identity,
      fetch: server.fetch,
      sleep: async () => {},
      lifecycle: {
        onFileUploaded: async (id) => {
          checkpoints.push(`file:${id}`);
        },
        onResponseCreated: async (id) => {
          checkpoints.push(`response:${id}`);
        },
        onServedIdentityValidated: async (id) => {
          checkpoints.push(`served:${id}`);
        },
        onCleanup: async (cleanup) => {
          checkpoints.push(`cleanup:${cleanup.status}`);
        },
      },
    },
  );
  assert.deepEqual(checkpoints, [
    "file:file-1",
    "response:response-1",
    "served:agent-1",
    "cleanup:deleted",
  ]);
});

test("reports failed remote cleanup through the lifecycle before throwing", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    deleteStates: [
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ],
  });
  const cleanup = [];
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
        lifecycle: {
          onCleanup: async (value) => {
            cleanup.push(value);
          },
        },
      },
    ),
    (error) =>
      error instanceof StudioError &&
      error.code === "REMOTE_CLEANUP_INCOMPLETE",
  );
  assert.deepEqual(cleanup, [{ status: "failed", attempts: 4 }]);
});

test("does not create a response or delete a file after lifecycle ownership is lost", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage();
  let checks = 0;
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
        lifecycle: {
          assertActive: async () => {
            checks += 1;
            if (checks === 2) throw new Error("lease lost");
          },
        },
      },
    ),
    (error) =>
      error instanceof StudioError &&
      error.cause instanceof Error &&
      error.cause.message === "lease lost",
  );
  assert.equal(
    server.calls().filter((call) => call.path === "/v2/responses").length,
    0,
  );
  assert.equal(
    server.calls().filter((call) => call.method === "DELETE").length,
    0,
  );
});

test("fails closed before upload when immutable identity is missing", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage();
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity: { ...identity, requestFields: {} },
        fetch: server.fetch,
      },
    ),
    (error) =>
      error instanceof StudioError && error.code === "IDENTITY_UNVERIFIED",
  );
  assert.equal(server.calls().length, 0);
});

test("rejects an invalid host cleanup window before uploading", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage();
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: 10_000,
        cleanupDeadline: 10_000,
        identity,
        fetch: server.fetch,
        now: () => 0,
      },
    ),
    (error) =>
      error instanceof StudioError && error.code === "HOST_BUDGET_INVALID",
  );
  assert.equal(server.calls().length, 0);
});

test("rejects an already-expired processing window before uploading", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage();
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: 9_999,
        cleanupDeadline: 20_000,
        identity,
        fetch: server.fetch,
        now: () => 10_000,
      },
    ),
    (error) =>
      error instanceof StudioError && error.code === "HOST_BUDGET_INVALID",
  );
  assert.equal(server.calls().length, 0);
});

test("reserved workflow payload fields fail closed before upload", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: workflowOutput() }],
  });
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity: {
          ...identity,
          requestFields: {
            config_id: "config-1",
            model: "attacker-agent",
            input: [{ role: "attacker" }],
            include: ["last"],
          },
        },
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
    (error) =>
      error instanceof StudioError && error.code === "IDENTITY_UNVERIFIED",
  );
  assert.equal(server.calls().length, 0);
});

test("treats cleanup failure as workflow failure after bounded DELETE retries", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: workflowOutput() }],
    deleteStates: [
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ],
  });
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
    (error) =>
      error instanceof StudioError &&
      error.code === "REMOTE_CLEANUP_INCOMPLETE",
  );
  assert.equal(
    server.calls().filter((call) => call.method === "DELETE").length,
    4,
  );
});

test("still deletes the remote file when a completed response is malformed", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const server = createFakeUpstage({
    responseStates: [
      {
        status: 200,
        body: {
          id: "response-1",
          status: "completed",
          model: "agent-1",
          output: [],
        },
      },
    ],
  });
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
  );
  assert.equal(
    server.calls().filter((call) => call.method === "DELETE").length,
    1,
  );
  assert.equal(server.file("file-1").deleted, true);
});

test("does not accept stale undocumented validation/review Studio nodes", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const output = workflowOutput();
  output.output.push({
    step_name: "review_기타",
    step_type: "review",
    text: JSON.stringify({
      kind: KIND,
      schema_version: "studio-document-envelope/v1",
      decision: "needs_human_review",
      issues: [{ code: "AMBIGUOUS" }],
      evidence: [
        { page: 1, elementId: "1", sourceKey: "review", coordinates: null },
      ],
    }),
  });
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: output }],
  });
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
    (error) =>
      error instanceof StudioError && error.code === "UNEXPECTED_STUDIO_STEP",
  );
  assert.equal(server.file("file-1").deleted, true);
});

test("fails closed when application validation lacks evidence for extracted claims", async () => {
  process.env.UPSTAGE_API_KEY = "fake-key";
  const output = workflowOutput();
  output.output.find((step) => step.model === "parse").content[0].text =
    JSON.stringify({
      elements: [
        {
          id: 0,
          page: 1,
          category: "paragraph",
          content: { text: "현장 참고 문서" },
        },
        {
          id: 2,
          page: 1,
          category: "paragraph",
          content: { text: "무관한 문장" },
        },
      ],
      content: { text: "현장 참고 문서\n무관한 문장" },
    });
  output.output.find(
    (step) => step.model === "extract_기타",
  ).content[0].additional_values = JSON.stringify({
    previous_step_name: "parse",
    cache_hit: false,
  });
  const server = createFakeUpstage({
    responseStates: [{ status: 200, body: output }],
  });
  await assert.rejects(
    runStudioWorkflow(
      KIND,
      new Uint8Array([1]),
      "synthetic.pdf",
      "application/pdf",
      {
        deadline: Date.now() + 10_000,
        cleanupDeadline: Date.now() + 20_000,
        identity,
        fetch: server.fetch,
        sleep: async () => {},
      },
    ),
    (error) =>
      error instanceof StudioError &&
      error.code === "ACCEPTED_CLAIM_MISSING_EVIDENCE",
  );
  assert.equal(server.file("file-1").deleted, true);
});
