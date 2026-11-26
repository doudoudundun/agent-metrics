import { describe, expect, it } from "vitest";
import {
  codexTurnMetadataKey,
  collectCodexTurnInputMetadata,
  type CodexTurnInputLogRow
} from "./turn-metadata.js";

const sessionId = "fixture-session-fast";
const turnId = "fixture-turn-fast";
const model = "gpt-6.1-sol";

function row(input: {
  target?: string;
  sqliteThreadId?: string;
  outerThreadId?: string;
  turnId?: string;
  turnAlias?: string;
  model?: string;
  turnModel?: string;
  codexTurnModel?: string;
  duplicateModel?: string;
  tier?: string;
  secondTier?: string;
  eventName?: string;
  secondEventName?: string;
} = {}): CodexTurnInputLogRow {
  const outerThreadId = input.outerThreadId ?? sessionId;
  const turnInputId = input.turnId ?? turnId;
  const turnSpanId = input.turnAlias ?? input.turnId ?? turnId;
  const turnModel = input.turnModel ?? input.model ?? model;
  const tagsJson = input.secondTier === undefined
    ? JSON.stringify({
        service_tier: input.tier ?? "priority",
        "feature.fast_mode": "true",
        display_name: "This text mentions service_tier but is only a value."
      })
    : `{"service_tier":${JSON.stringify(input.tier ?? "priority")},"service_tier":${JSON.stringify(input.secondTier)},"feature.fast_mode":"true","display_name":"service_tier is only a value here"}`;
  const dispatchFields = [
    `otel.name=${JSON.stringify(input.eventName ?? "op.dispatch.turn_input")}`,
    `submission.id=${JSON.stringify("fixture-submission")}`,
    `codex.op=${JSON.stringify("fixture-op")}`
  ];
  if (input.secondEventName !== undefined) {
    dispatchFields.push(`otel.name=${JSON.stringify(input.secondEventName)}`);
  }
  const codexTurnFields = [
    `conversation.id=${JSON.stringify("fixture-conversation")}`,
    `turn.id=${JSON.stringify(turnInputId)}`
  ];
  if (input.codexTurnModel !== undefined) {
    codexTurnFields.push(`model=${input.codexTurnModel}`);
  }
  const turnFields = [
    `otel.name=${JSON.stringify("fixture-turn-span")}`,
    `thread.id=${outerThreadId}`,
    `turn.id=${turnSpanId}`,
    `model=${turnModel}`,
    `model=${input.duplicateModel ?? turnModel}`,
    `codex.turn.reasoning_effort=${JSON.stringify("max")}`
  ];
  const body = [
    `session_loop{thread_id=${outerThreadId}}`,
    `:submission_dispatch{${dispatchFields.join(" ")}}`,
    `:codex.turn_input{${codexTurnFields.join(" ")}}`,
    `:turn{${turnFields.join(" ")}}`,
    `:session_task.run:run_turn:run_sampling_request{turn_id=${turnInputId} model=${turnModel} cwd=${JSON.stringify("/private/fixture/path")}}`,
    `: model=${JSON.stringify(turnModel)} tags_json=${tagsJson}`
  ].join("");
  return {
    target: input.target ?? "feedback_tags",
    thread_id: input.sqliteThreadId ?? sessionId,
    feedback_log_body: body
  };
}

function interAgentRow(input: {
  target?: string;
  sqliteThreadId?: string;
  outerThreadId?: string;
  turnThreadId?: string;
  turnId?: string;
  samplingTurnId?: string;
  trySamplingTurnId?: string;
  model?: string;
  turnModel?: string;
  samplingModel?: string;
  trySamplingModel?: string;
  tier?: string;
  secondTier?: string;
  eventName?: string;
  secondEventName?: string;
  turnOtelName?: string;
  omitSamplingSpans?: boolean;
  fakeSamplingInTag?: boolean;
  plaintextBetweenTurnAndSampling?: boolean;
  plaintextBetweenSamplingAndTry?: boolean;
} = {}): CodexTurnInputLogRow {
  const outerThreadId = input.outerThreadId ?? sessionId;
  const turnThreadId = input.turnThreadId ?? outerThreadId;
  const currentTurnId = input.turnId ?? turnId;
  const samplingTurnId = input.samplingTurnId ?? currentTurnId;
  const trySamplingTurnId = input.trySamplingTurnId ?? currentTurnId;
  const currentModel = input.model ?? "gpt-6-astra";
  const turnModel = input.turnModel ?? currentModel;
  const samplingModel = input.samplingModel ?? currentModel;
  const trySamplingModel = input.trySamplingModel ?? currentModel;
  const tagsJson = input.secondTier === undefined
    ? JSON.stringify({
        service_tier: input.tier ?? "priority",
        display_name: input.fakeSamplingInTag
          ? `:run_sampling_request{turn_id=${currentTurnId} model=${currentModel}}`
          : "service_tier and request markers in this value are inert."
      })
    : `{"service_tier":${JSON.stringify(input.tier ?? "priority")},"service_tier":${JSON.stringify(input.secondTier)}}`;
  const dispatchFields = [
    `otel.name=${JSON.stringify(input.eventName ?? "op.dispatch.inter_agent_communication")}`,
    `submission.id=${JSON.stringify("fixture-submission")}`
  ];
  if (input.secondEventName !== undefined) {
    dispatchFields.push(`otel.name=${JSON.stringify(input.secondEventName)}`);
  }
  const body = [
    `session_loop{thread_id=${outerThreadId}}`,
    `:submission_dispatch{${dispatchFields.join(" ")}}`,
    `:turn{otel.name=${JSON.stringify(input.turnOtelName ?? "session_task.turn")} thread.id=${turnThreadId} turn.id=${currentTurnId} model=${turnModel}}`
  ];
  if (!input.omitSamplingSpans) {
    body.push(
      `${input.plaintextBetweenTurnAndSampling ? ": arbitrary plaintext " : ":session_task.run:run_turn"}:run_sampling_request{turn_id=${samplingTurnId} model=${samplingModel} cwd=${JSON.stringify("/private/fixture/path")}}`,
      `${input.plaintextBetweenSamplingAndTry ? ": arbitrary plaintext " : ""}:try_run_sampling_request{turn_id=${trySamplingTurnId} model=${trySamplingModel}}`
    );
  }
  body.push(`: model=${JSON.stringify(currentModel)} tags_json=${tagsJson}`);

  return {
    target: input.target ?? "feedback_tags",
    thread_id: input.sqliteThreadId ?? sessionId,
    feedback_log_body: body.join("")
  };
}

describe("collectCodexTurnInputMetadata", () => {
  it("reads service tier from the matching nested turn-input span", () => {
    const metadata = collectCodexTurnInputMetadata([row()]);

    expect(metadata.get(codexTurnMetadataKey(sessionId, turnId))).toEqual({
      model,
      serviceTier: "priority"
    });
  });

  it.each([
    { target: "codex_core::client" },
    { eventName: "op.dispatch.inter_agent_communication" },
    { sqliteThreadId: "different-thread" },
    { outerThreadId: "different-thread" },
    { turnAlias: "different-turn" },
    { model: "   " }
  ])("rejects non-matching outer metadata: $target $eventName $sqliteThreadId $outerThreadId $turnAlias $turnModel $model", (override) => {
    expect(collectCodexTurnInputMetadata([row(override)])).toEqual(new Map());
  });

  it("rejects conflicting duplicate critical fields and event names", () => {
    expect(collectCodexTurnInputMetadata([row({ duplicateModel: "gpt-6.1-sol-fast" })])).toEqual(
      new Map()
    );
    expect(collectCodexTurnInputMetadata([row({ secondEventName: "op.dispatch.turn_input_other" })])).toEqual(
      new Map()
    );
    expect(collectCodexTurnInputMetadata([row({ codexTurnModel: "gpt-6.1-sol-fast" })])).toEqual(
      new Map()
    );
  });

  it("rejects ambiguous duplicate service_tier keys in tags_json", () => {
    expect(collectCodexTurnInputMetadata([row({ tier: "default", secondTier: "priority" })])).toEqual(
      new Map()
    );
  });

  it("ignores service_tier text inside unrelated tag values", () => {
    expect(collectCodexTurnInputMetadata([row()])).toEqual(
      new Map([
        [
          codexTurnMetadataKey(sessionId, turnId),
          { model, serviceTier: "priority" }
        ]
      ])
    );
  });

  it("rejects turns whose bounded log records disagree on model or tier", () => {
    const tierConflict = collectCodexTurnInputMetadata([
      row(),
      row({ tier: "default" })
    ]);
    const modelConflict = collectCodexTurnInputMetadata([
      row(),
      row({ model: "gpt-6.1-sol-fast" })
    ]);

    expect(tierConflict.has(codexTurnMetadataKey(sessionId, turnId))).toBe(false);
    expect(modelConflict.has(codexTurnMetadataKey(sessionId, turnId))).toBe(false);
  });

  it("keeps repeated identical turn-input records as one unambiguous entry", () => {
    expect(collectCodexTurnInputMetadata([row(), row()])).toEqual(
      new Map([
        [
          codexTurnMetadataKey(sessionId, turnId),
          { model, serviceTier: "priority" }
        ]
      ])
    );
  });

  it("reads a unique tier from thread-bound inter-agent sampling spans", () => {
    const metadata = collectCodexTurnInputMetadata([interAgentRow()]);

    expect(metadata.get(codexTurnMetadataKey(sessionId, turnId))).toEqual({
      model: "gpt-6-astra",
      serviceTier: "priority"
    });
  });

  it.each([
    { eventName: "op.dispatch.turn_input" },
    { sqliteThreadId: "different-thread" },
    { outerThreadId: "different-thread" },
    { turnThreadId: "different-thread" },
    { samplingTurnId: "different-turn" },
    { trySamplingTurnId: "different-turn" },
    { samplingModel: "gpt-6.1-sol" },
    { trySamplingModel: "gpt-6.1-sol" },
    { turnOtelName: "session_task.other" },
    { plaintextBetweenTurnAndSampling: true },
    { plaintextBetweenSamplingAndTry: true },
    { omitSamplingSpans: true }
  ])("rejects unbound inter-agent sampling metadata: $eventName $sqliteThreadId $outerThreadId $turnThreadId $samplingTurnId $trySamplingTurnId $samplingModel $trySamplingModel $turnOtelName $omitSamplingSpans", (override) => {
    expect(collectCodexTurnInputMetadata([interAgentRow(override)])).toEqual(new Map());
  });

  it("rejects conflicting inter-agent event names, tier keys, and per-turn metadata", () => {
    expect(collectCodexTurnInputMetadata([
      interAgentRow({ secondEventName: "op.dispatch.turn_input" })
    ])).toEqual(new Map());
    expect(collectCodexTurnInputMetadata([
      interAgentRow({ tier: "default", secondTier: "priority" })
    ])).toEqual(new Map());
    expect(collectCodexTurnInputMetadata([
      interAgentRow(),
      interAgentRow({ tier: "default" })
    ])).toEqual(new Map());
    expect(collectCodexTurnInputMetadata([
      interAgentRow(),
      interAgentRow({ model: "gpt-6.1-sol" })
    ])).toEqual(new Map());
  });

  it("does not treat request markers inside a tag value as sampling spans", () => {
    expect(collectCodexTurnInputMetadata([
      interAgentRow({ omitSamplingSpans: true, fakeSamplingInTag: true })
    ])).toEqual(new Map());
  });
});
