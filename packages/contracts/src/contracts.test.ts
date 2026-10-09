import { describe, expect, it } from "vitest";
import {
  AggregateMetaSchema,
  AnalyticsFilterSchema,
  ApiErrorCode,
  ApiErrorResponseSchema,
  DEFAULT_DESKTOP_SETTINGS,
  DesktopIpcChannel,
  DesktopIpcSchemas,
  DesktopPlatformInfoSchema,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  DesktopSettingsViewSchema,
  EventTypeSchema,
  HealthResponseSchema,
  ManualSyncRequestSchema,
  ManualSyncResponseSchema,
  OverviewResponseSchema,
  RuntimeStatusSchema,
  SessionDetailResponseSchema,
  SessionRowSchema,
  SessionTimelineEntrySchema,
  SessionsResponseSchema,
  SourceVendorSchema,
  SyncStatusResponseSchema,
  TimeScopeSchema,
  TokenTrendResponseSchema,
  ToolsResponseSchema,
  WidgetInteractionSchema,
  WidgetSnapshotResponseSchema
} from "./index.js";

const aggregateMeta = {
  mode: "calendar" as const,
  range: "day" as const,
  timezone: "UTC",
  windowStart: "2026-05-25T00:00:00.000Z",
  windowEnd: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-25T12:00:00.000Z"
};

const tokenComponents = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheCreationTokens: 10
};

describe("common filters and pagination", () => {
  it("accepts calendar/rolling/lifetime/custom time scopes", () => {
    expect(TimeScopeSchema.safeParse({ mode: "calendar", range: "day" }).success).toBe(true);
    expect(TimeScopeSchema.safeParse({ mode: "rolling", range: "week" }).success).toBe(true);
    expect(TimeScopeSchema.safeParse({ mode: "lifetime", range: "month" }).success).toBe(true);
    expect(
      TimeScopeSchema.safeParse({
        mode: "custom",
        startAt: "2026-05-01T00:00:00.000Z",
        endAt: "2026-05-02T00:00:00.000Z"
      }).success
    ).toBe(true);
  });

  it("rejects unknown mode/range enums", () => {
    expect(TimeScopeSchema.safeParse({ mode: "yearly", range: "day" }).success).toBe(false);
    expect(TimeScopeSchema.safeParse({ mode: "calendar", range: "year" }).success).toBe(false);
  });

  it("accepts additive analytics filters and re-exports source/event identifiers", () => {
    expect(SourceVendorSchema.safeParse("opencode").success).toBe(true);
    expect(SourceVendorSchema.safeParse("zcode").success).toBe(true);
    expect(SourceVendorSchema.safeParse("kimicode").success).toBe(true);
    expect(SourceVendorSchema.safeParse("dsh").success).toBe(true);
    expect(SourceVendorSchema.safeParse("mimo").success).toBe(true);
    expect(EventTypeSchema.safeParse("tool.called").success).toBe(true);
    expect(EventTypeSchema.safeParse("not.a.type").success).toBe(false);
    expect(
      AnalyticsFilterSchema.safeParse({
        mode: "calendar",
        range: "day",
        sourceVendors: ["codex", "cursor"],
        sourceInstanceIds: ["codex:default"]
      }).success
    ).toBe(true);
  });
});

describe("error and health contracts", () => {
  it("parses a valid ApiErrorResponse and pins known error codes", () => {
    const result = ApiErrorResponseSchema.safeParse({
      error: {
        code: ApiErrorCode.INVALID_REQUEST,
        message: "bad filter",
        requestId: "req_1",
        details: { field: "mode" }
      }
    });
    expect(result.success).toBe(true);
    expect(ApiErrorCode.SESSION_NOT_FOUND).toBe("SESSION_NOT_FOUND");
    expect(ApiErrorCode.SYNC_SHUTTING_DOWN).toBe("SYNC_SHUTTING_DOWN");
    expect(ApiErrorCode.PROJECTION_NOT_READY).toBe("PROJECTION_NOT_READY");
  });

  it("rejects an error payload without requestId", () => {
    expect(
      ApiErrorResponseSchema.safeParse({
        error: { code: "X", message: "y" }
      }).success
    ).toBe(false);
  });

  it("parses health response with apiVersion 2 and eventSchemaVersion 2", () => {
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        apiVersion: 2,
        eventSchemaVersion: 2
      }).success
    ).toBe(true);
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        apiVersion: 1,
        eventSchemaVersion: 2
      }).success
    ).toBe(false);
  });
});

describe("overview / tools / trend / widget", () => {
  it("parses a valid OverviewResponse", () => {
    const result = OverviewResponseSchema.safeParse({
      ...aggregateMeta,
      ...tokenComponents,
      sessionCount: 1,
      turnCount: 2,
      responseCount: 1,
      totalToolCalls: 3,
      successfulExecutions: 2,
      failedExecutions: 1,
      startedOnlyExecutions: 0,
      successRate: 0.6667,
      editOperationCount: 1,
      affectedFileCount: 2,
      insertions: 10,
      deletions: 3,
      tokensByModel: [
        { model: "gpt-5", sourceVendor: "codex", costUsd: 0.42, ...tokenComponents }
      ],
      sourceBreakdown: [
        {
          sourceVendor: "claude-code",
          sessionCount: 1,
          turnCount: 2,
          totalTokens: 100,
          toolCalls: 3,
          costUsd: 1.5
        }
      ],
      providerBreakdown: [
        { providerId: "unknown", providerHost: null, totalTokens: 100 }
      ],
      totalCostUsd: 1.92
    });
    expect(result.success).toBe(true);
  });

  it("rejects overview successRate outside [0,1]", () => {
    const result = OverviewResponseSchema.safeParse({
      ...aggregateMeta,
      ...tokenComponents,
      sessionCount: 0,
      turnCount: 0,
      responseCount: 0,
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      startedOnlyExecutions: 0,
      successRate: 1.5,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      tokensByModel: [],
      sourceBreakdown: [],
      providerBreakdown: [],
      totalCostUsd: 0
    });
    expect(result.success).toBe(false);
  });

  it("parses tools and token-trend responses", () => {
    expect(
      ToolsResponseSchema.safeParse({
        ...aggregateMeta,
        rows: [{ toolName: "Read", count: 2, failures: 0, averageDurationMs: 12 }]
      }).success
    ).toBe(true);

    expect(
      TokenTrendResponseSchema.safeParse({
        ...aggregateMeta,
        rows: [
          {
            bucketStart: "2026-05-25T00:00:00.000Z",
            label: "00:00",
            ...tokenComponents,
            cacheHitRate: 0.1
          }
        ]
      }).success
    ).toBe(true);
  });

  it("parses widget snapshot with fixed calendar day scope", () => {
    const result = WidgetSnapshotResponseSchema.safeParse({
      generatedAt: "2026-05-25T12:00:00.000Z",
      scope: {
        mode: "calendar",
        range: "day",
        windowStart: "2026-05-25T00:00:00.000Z",
        windowEnd: "2026-05-25T12:00:00.000Z"
      },
      metrics: {
        ...tokenComponents,
        sessionCount: 1,
        logicalToolCalls: 4,
        cacheHitRate: 0.2,
        toolSuccessRate: 0.9,
        editOperationCount: 1,
        affectedFileCount: 2,
        totalCostUsd: 1.25
      }
    });
    expect(result.success).toBe(true);

    // Rolling scope is rejected for the widget snapshot contract.
    expect(
      WidgetSnapshotResponseSchema.safeParse({
        generatedAt: "2026-05-25T12:00:00.000Z",
        scope: {
          mode: "rolling",
          range: "day",
          windowStart: "2026-05-24T12:00:00.000Z",
          windowEnd: "2026-05-25T12:00:00.000Z"
        },
        metrics: {
          ...tokenComponents,
          sessionCount: 0,
          logicalToolCalls: 0,
          cacheHitRate: 0,
          toolSuccessRate: 0,
          editOperationCount: 0,
          affectedFileCount: 0
        }
      }).success
    ).toBe(false);
  });
});

describe("sessions", () => {
  it("parses session list and detail responses with composite identity", () => {
    const row = {
      sourceInstanceId: "claude:default",
      sessionId: "ses_1",
      workspacePath: "D:/projects/dev/agent-metrics",
      sourceVendor: "claude-code" as const,
      sourceAdapters: ["claude-transcript" as const],
      providerId: "unknown",
      providerHost: null,
      turnCount: 1,
      totalTokens: 100,
      lastModel: "gpt-5",
      lastActivityAt: "2026-05-25T08:00:00.000Z"
    };
    expect(SessionRowSchema.safeParse(row).success).toBe(true);
    expect(
      SessionsResponseSchema.safeParse({
        ...aggregateMeta,
        rows: [row],
        nextCursor: null
      }).success
    ).toBe(true);

    expect(
      SessionDetailResponseSchema.safeParse({
        ...aggregateMeta,
        sourceInstanceId: "claude:default",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        sourceVendor: "claude-code",
        sourceAdapters: ["claude-transcript"],
        context: {
          executionPath: null,
          skillsLoaded: false,
          skillNames: []
        },
        timeline: {
          rows: [
            {
              eventId: "evt_1",
              createdAt: "2026-05-25T08:00:00.000Z",
              type: "session.started",
              sourceVendor: "claude-code",
              sourceAdapters: ["claude-transcript"],
              toolCallId: null,
              toolName: null,
              status: null,
              durationMs: null,
              providerId: null,
              providerHost: null,
              filesChanged: [],
              insertions: null,
              deletions: null,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            }
          ],
          nextCursor: null
        }
      }).success
    ).toBe(true);
  });

  it("rejects a session row without sourceInstanceId", () => {
    expect(
      SessionRowSchema.safeParse({
        sessionId: "ses_1",
        workspacePath: ".",
        sourceVendor: "claude-code",
        sourceAdapters: [],
        providerId: "unknown",
        providerHost: null,
        turnCount: 0,
        totalTokens: 0,
        lastModel: null,
        lastActivityAt: "2026-05-25T08:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("rejects timeline entries with unknown event types", () => {
    const baseEntry = {
      eventId: "evt_1",
      createdAt: "2026-05-25T08:00:00.000Z",
      sourceVendor: "claude-code" as const,
      sourceAdapters: ["claude-transcript" as const],
      toolCallId: null,
      toolName: null,
      status: null,
      durationMs: null,
      providerId: null,
      providerHost: null,
      filesChanged: [] as string[],
      insertions: null,
      deletions: null,
      promptId: null,
      promptChars: null,
      messageId: null,
      model: null,
      stopReason: null,
      responseChars: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      totalTokens: null,
      usageSource: null
    };
    expect(
      SessionTimelineEntrySchema.safeParse({ ...baseEntry, type: "session.started" }).success
    ).toBe(true);
    expect(
      SessionTimelineEntrySchema.safeParse({ ...baseEntry, type: "made.up.type" }).success
    ).toBe(false);
  });
});

describe("sync contracts", () => {
  it("parses sync status and manual sync response", () => {
    expect(
      SyncStatusResponseSchema.safeParse({
        generatedAt: "2026-05-25T12:00:00.000Z",
        shuttingDown: false,
        adapters: [
          {
            adapterInstanceId: "claude-transcript@claude:default",
            sourceInstanceId: "claude:default",
            sourceAdapter: "claude-transcript",
            sourceVendor: "claude-code",
            status: "ready",
            activeRunId: null,
            pendingRunId: null,
            lastStartedAt: null,
            lastCompletedAt: null,
            lastSuccessfulAt: "2026-05-25T11:00:00.000Z",
            nextScheduledAt: null,
            lastError: null,
            consecutiveFailures: 0
          }
        ]
      }).success
    ).toBe(true);

    expect(ManualSyncRequestSchema.safeParse({}).success).toBe(true);
    expect(ManualSyncRequestSchema.safeParse({ reason: "x".repeat(201) }).success).toBe(false);

    expect(
      ManualSyncResponseSchema.safeParse({
        requestId: "req_1",
        acceptedAt: "2026-05-25T12:00:00.000Z",
        runs: [
          {
            adapterInstanceId: "claude-transcript@claude:default",
            runId: "run_1",
            disposition: "started"
          }
        ]
      }).success
    ).toBe(true);
  });
});

describe("desktop settings and IPC", () => {
  it("parses version 2 desktop settings and defaults", () => {
    expect(DesktopSettingsSchema.safeParse(DEFAULT_DESKTOP_SETTINGS).success).toBe(true);
    expect(DEFAULT_DESKTOP_SETTINGS.settingsVersion).toBe(2);
    expect(DEFAULT_DESKTOP_SETTINGS.widgetDockEdge).toBe("right");
    expect(DEFAULT_DESKTOP_SETTINGS.widgetModeOnStartup).toBe("collapsed");
  });

  it("rejects unknown settingsVersion and unknown patch fields", () => {
    expect(
      DesktopSettingsSchema.safeParse({
        ...DEFAULT_DESKTOP_SETTINGS,
        settingsVersion: 1
      }).success
    ).toBe(false);

    expect(
      DesktopSettingsPatchSchema.safeParse({ widgetBounds: { x: 0, y: 0, width: 1, height: 1 } })
        .success
    ).toBe(false);
  });

  it("parses platform info and settings view", () => {
    expect(
      DesktopPlatformInfoSchema.safeParse({
        platform: "win32",
        supportsLaunchAtLogin: true,
        supportsWidget: true
      }).success
    ).toBe(true);

    expect(
      DesktopSettingsViewSchema.safeParse({
        ...DEFAULT_DESKTOP_SETTINGS,
        platform: "darwin",
        supportsLaunchAtLogin: true,
        supportsWidget: true
      }).success
    ).toBe(true);
  });

  it("parses runtime status", () => {
    expect(
      RuntimeStatusSchema.safeParse({
        state: "ready",
        coreEndpoint: "http://127.0.0.1:45183",
        children: [
          {
            name: "core",
            ownership: "managed",
            state: "ready",
            pid: 1234,
            restartCount: 0,
            lastExit: null,
            errorSummary: null
          }
        ],
        lastUpdatedAt: "2026-05-25T12:00:00.000Z"
      }).success
    ).toBe(true);
  });

  it("parses WidgetInteraction separately from mode and data status", () => {
    expect(
      WidgetInteractionSchema.safeParse({
        dragging: false,
        pointerInside: true,
        keyboardFocusInside: false
      }).success
    ).toBe(true);
    expect(
      WidgetInteractionSchema.safeParse({
        dragging: false,
        pointerInside: true
      }).success
    ).toBe(false);
  });

  it("pins every IPC channel from the section 17 table", () => {
    const expectedChannels = [
      "desktop:get-platform-info",
      "desktop:get-runtime-status",
      "desktop:get-settings",
      "desktop:update-settings",
      "desktop:restart-runtime",
      "desktop:show-main-window",
      "desktop:hide-widget",
      "desktop:set-widget-mode",
      "desktop:widget-pointer-enter",
      "desktop:widget-pointer-leave",
      "desktop:widget-focus-within",
      "desktop:widget-pointer-begin",
      "desktop:widget-pointer-update",
      "desktop:widget-pointer-end",
      "desktop:show-widget-menu"
    ];
    expect(Object.values(DesktopIpcChannel).sort()).toEqual([...expectedChannels].sort());
    for (const channel of expectedChannels) {
      expect(DesktopIpcSchemas[channel as keyof typeof DesktopIpcSchemas]).toBeDefined();
    }
  });

  it("validates a sample IPC request/response pair", () => {
    const restart = DesktopIpcSchemas[DesktopIpcChannel.RESTART_RUNTIME];
    expect(restart.request.safeParse({ child: "core" }).success).toBe(true);
    expect(restart.request.safeParse({ child: "renderer" }).success).toBe(false);

    const setMode = DesktopIpcSchemas[DesktopIpcChannel.SET_WIDGET_MODE];
    expect(setMode.request.safeParse({ mode: "pinned" }).success).toBe(true);
    expect(setMode.response.safeParse({ visible: true, mode: "pinned" }).success).toBe(true);
  });
});

describe("AggregateMeta", () => {
  it("requires timezone and updatedAt", () => {
    expect(AggregateMetaSchema.safeParse(aggregateMeta).success).toBe(true);
    expect(
      AggregateMetaSchema.safeParse({
        mode: "calendar",
        range: "day",
        timezone: "UTC",
        windowStart: null,
        windowEnd: null
      }).success
    ).toBe(false);
  });
});
