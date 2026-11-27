/**
 * Official list prices in USD per 1M tokens (standard on-demand tier).
 * Base catalog captured 2026-10-09 from: openai.com, platform.claude.com, docs.z.ai,
 * api-docs.deepseek.com, platform.minimax.io, mimo.mi.com, platform.kimi.ai,
 * x.ai API docs. Speed-specific OpenAI/Claude/Cursor/Kimi/MiMo rates were
 * verified again 2026-10-23; their source links appear alongside those entries.
 * Kimi K3.1 Pro rows use the refreshed upstream USD rate card.
 *
 * WorkBuddy/CodeBuddy coverage added 2026-10-21 from the model table shipped
 * inside the desktop app (`resources/app.asar.unpacked/cli/product.json`, 58
 * rows) plus `product.cloudhosted.json`; the per-token rates for those rows come
 * from api-docs.deepseek.com, platform.minimax.io (M2/M3),
 * platform.kimi.ai (K2/K3), docs.z.ai (GLM), cloud.tencent.com Token Plan and
 * hy.tencent.com (Hunyuan). CNY rows are converted at the rate Tencent itself
 * publishes on its Token Plan page (CNY 6 -> $0.834, i.e. 7.194 CNY/USD).
 *
 * DeepSeek rows use peak-hour pricing (off-peak is half price); the discount is
 * deliberately not applied per-row because relays/providers bill DeepSeek at
 * their own dynamic rates, so a uniform peak-hour estimate is the common
 * denominator. GLM rows use the <32K input tier, MiniMax-M3 the <=512K tier at
 * its 50% discount, Claude cache writes the 5-minute tier, and Kimi K3 cache
 * writes the 5-minute TTL tier. Estimates for reference only, not billing data.
 *
 * WorkBuddy routing aliases (`default`, `auto`, `default-model`, `fast-model`,
 * `balanced-model`, `primary-model`, `deep-model`) are deliberately absent: they
 * land on whichever model the router picks, so they have no list price of their
 * own. Same for `hunyuan-chat` (Hunyuan-Turbos) and `hunyuan-2.0-*`, which have
 * no published per-token rate.
 *
 * Cursor rows re-verified 2026-10-27 against cursor.com/docs/models/* and
 * /docs/models-and-pricing: Cursor resells at the provider's published rate with
 * no markup, but its own speed tiers are separate cards (Composer 2.5 standard vs
 * Fast, Grok 4.7 standard vs Fast), and effort suffixes never move the price.
 * Cursor's long-context tiers (Grok 4.7 500k) are absent because the stored
 * usage rows carry no input-length tier to select them.
 *
 * Antigravity (T3) coverage added 2026-11-23 from the official-source snapshot
 * inside T3 Code's own rate table (~/.t3/userdata/usage-model-rates.json,
 * fetched 2026-11-23; first-party Gemini rows sourced from ai.google.dev,
 * aistudio.google.com and cloud.google.com). Antigravity sells seat-based
 * subscription quotas, so these per-token figures are API reference estimates
 * only, never subscription bills. T3's low/medium/high/xhigh suffixes are
 * reasoning/thinking levels priced at the base card, and its permission /
 * interaction modes are control-plane settings with no price at all. The
 * generic router target `antigravity-default` stays unpriced on purpose.
 */

import { normalizeModelId, resolveUsageMode, type UsageMode } from "@agent-metrics/event-schema";

export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
};

// Shared rate cards referenced by several Antigravity (T3) rows below, so
// thinking-tier suffixes and role aliases cannot drift from the base card.
// Snapshot 2026-11-23: Gemini rows are Google first-party list prices
// (ai.google.dev / aistudio.google.com / cloud.google.com); Gemini does not
// bill cache writes on these cards, so cacheWritePer1M stays 0. Carbon is a
// promotional rate through 2026-11-30; Google lists 4/20/cacheRead 0.20 from
// 2026-12-01 (single-snapshot convention keeps today's promo card). gpt-oss
// has no OpenAI first-party API price card, so its row is Groq's hosted
// reference rate — NOT an OpenAI list price.
const GEMINI_4_NEON_CARD: ModelPricing = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.15, cacheWritePer1M: 0 };
const GEMINI_4_CARBON_CARD: ModelPricing = { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 0 };
const GEMINI_4_ARGON_CARD: ModelPricing = { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 0 };
const GEMINI_4_HYDROGEN_CARD: ModelPricing = { inputPer1M: 1.5, outputPer1M: 7.5, cacheReadPer1M: 0.075, cacheWritePer1M: 0 };
const GEMINI_3_X_FLASH_CARD: ModelPricing = { inputPer1M: 0.75, outputPer1M: 3.75, cacheReadPer1M: 0.075, cacheWritePer1M: 0 };
const GEMINI_3_1_PRO_CARD: ModelPricing = { inputPer1M: 2, outputPer1M: 12, cacheReadPer1M: 0.2, cacheWritePer1M: 0 };
const GPT_OSS_120B_CARD: ModelPricing = { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075, cacheWritePer1M: 0 };

export const MODEL_PRICING_USD: Record<string, ModelPricing> = {
  "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25, cacheWritePer1M: 0 },
  "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5, cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
  "gpt-5.5": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // OpenAI rows use short-context rates; long-context modifiers are not inferred.
  // GPT-6.2 rates verified 2026-11-18: https://developers.openai.com/api/docs/pricing
  "gpt-6.2-astra": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.4, cacheWritePer1M: 10 },
  "gpt-6.2-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  "gpt-6-astra": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "gpt-6.1-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  // OpenAI standard API rates, <=272K input and 30-minute cache retention (2026-10-27).
  "gpt-6.1-terra": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.05, cacheWritePer1M: 1.25 },
  "gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125 },
  // Promotional price through 2026-11-30 per the OpenAI pricing page.
  "gpt-5.6-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
  // <=272K context tier (2x above); terra rates confirmed by gradually.ai.
  "gpt-5.6-terra": { inputPer1M: 2, outputPer1M: 12, cacheReadPer1M: 0.2, cacheWritePer1M: 2.5 },
  "gpt-5.6-luna": { inputPer1M: 0.2, outputPer1M: 1.2, cacheReadPer1M: 0.02, cacheWritePer1M: 0.25 },
  // Cursor's short-context Fast card (cursor.com/docs/models/gpt-5-6-luna).
  "gpt-5.6-luna-fast": { inputPer1M: 0.4, outputPer1M: 2.4, cacheReadPer1M: 0.04, cacheWritePer1M: 0.5 },
  "gpt-6-sol": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, cacheWritePer1M: 2.5 },
  "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14, cacheReadPer1M: 0.175, cacheWritePer1M: 0 },
  // Claude API standard pricing; cache writes use the 5-minute tier.
  // 5.2 generation: $8/$40 card, cache hits at 0.025x input, 5m cache writes $10.
  "claude-fable-5-2": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.2, cacheWritePer1M: 10 },
  "claude-mythos-5-2": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.2, cacheWritePer1M: 10 },
  "claude-fable-5-1": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 0.25, cacheWritePer1M: 12.5 },
  "claude-mythos-5-1": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 0.25, cacheWritePer1M: 12.5 },
  "claude-fable-5": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "claude-mythos-5": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "claude-opus-5": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-5-fast": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  // Cursor's thinking-effort suffix on Opus 5. Cursor bills every Opus 5 prompt at
  // the base rate regardless of thinking depth (only the separate
  // `claude-opus-5-fast` id costs 2x), so this is the same card as claude-opus-5.
  "claude-opus-5-thinking-high": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25
  },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  // Sonnet 5.5 launched at unchanged Sonnet 5 pricing (Anthropic).
  "claude-sonnet-5": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, cacheWritePer1M: 2.5 },
  "claude-sonnet-5-5": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  // Cursor effort-suffixed variant of sonnet-5-5.
  "claude-sonnet-5-5-high": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  "claude-opus-5-5": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 5 },
  "claude-opus-5-5-fast": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.4, cacheWritePer1M: 10 },
  "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  // Antigravity/T3 also serves Opus 4.6; platform.claude.com standard card
  // (5-minute cache-write tier), snapshot 2026-11-23.
  "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  // <=100K prompt tier; over 100K is priced higher.
  "claude-haiku-5-5": { inputPer1M: 0.1, outputPer1M: 0.5, cacheReadPer1M: 0.01, cacheWritePer1M: 0.125 },
  "claude-haiku-4-5-20251001": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  // GLM-5.4 uses GLM-5.3's published reference card while its own card is absent.
  "glm-5.4": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5.3": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5.3-flash": { inputPer1M: 0.15, outputPer1M: 0.5, cacheReadPer1M: 0.03, cacheWritePer1M: 0 },
  // Mistral's published identifier and rate for the same GLM 5.3 Flash model.
  "zai-glm-5-3-flash": { inputPer1M: 0.15, outputPer1M: 0.5, cacheReadPer1M: 0.03, cacheWritePer1M: 0 },
  "glm-5.3-flashx": { inputPer1M: 0.37, outputPer1M: 1.25, cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
  "glm-5.2": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5.1": { inputPer1M: 1.4, outputPer1M: 4.4, cacheReadPer1M: 0.26, cacheWritePer1M: 0 },
  "glm-5": { inputPer1M: 1, outputPer1M: 3.2, cacheReadPer1M: 0.2, cacheWritePer1M: 0 },
  "glm-4.7": { inputPer1M: 0.6, outputPer1M: 2.2, cacheReadPer1M: 0.11, cacheWritePer1M: 0 },
  // WorkBuddy serves GLM-5.0 / 5.0-Turbo / 5v-Turbo / 4.6 / 4.6V alongside the
  // 5.1+ rows above; z.ai's own rate card (docs.z.ai, snapshot 2026-10-20).
  "glm-5.0": { inputPer1M: 1, outputPer1M: 3.2, cacheReadPer1M: 0.2, cacheWritePer1M: 0 },
  "glm-5.0-turbo": { inputPer1M: 1.2, outputPer1M: 4, cacheReadPer1M: 0.24, cacheWritePer1M: 0 },
  "glm-5-turbo": { inputPer1M: 1.2, outputPer1M: 4, cacheReadPer1M: 0.24, cacheWritePer1M: 0 },
  "glm-5v-turbo": { inputPer1M: 1.2, outputPer1M: 4, cacheReadPer1M: 0.24, cacheWritePer1M: 0 },
  "glm-4.6": { inputPer1M: 0.6, outputPer1M: 2.2, cacheReadPer1M: 0.11, cacheWritePer1M: 0 },
  "glm-4.6v": { inputPer1M: 0.3, outputPer1M: 0.9, cacheReadPer1M: 0.05, cacheWritePer1M: 0 },
  // Gemini paid standard API rates: Argon promotion through Nov 30, 2026;
  // Flash promotions through Dec 31, 2026. Explicit cache storage fees excluded.
  "gemini-4-argon": GEMINI_4_ARGON_CARD,
  "gemini-3.8-flash": GEMINI_3_X_FLASH_CARD,
  "gemini-3.6-flash": GEMINI_3_X_FLASH_CARD,
  // Antigravity (T3) base cards from the 2026-11-23 snapshot; see header note.
  "gemini-4-neon": GEMINI_4_NEON_CARD,
  "gemini-4-carbon": GEMINI_4_CARBON_CARD,
  "gemini-4-hydrogen": GEMINI_4_HYDROGEN_CARD,
  "gemini-3.7-flash": GEMINI_3_X_FLASH_CARD,
  // T3 reasoning/thinking tiers (low/medium/high/xhigh) reuse the base card.
  "gemini-4-neon-low": GEMINI_4_NEON_CARD,
  "gemini-4-neon-medium": GEMINI_4_NEON_CARD,
  "gemini-4-neon-high": GEMINI_4_NEON_CARD,
  "gemini-4-neon-xhigh": GEMINI_4_NEON_CARD,
  "gemini-4-carbon-low": GEMINI_4_CARBON_CARD,
  "gemini-4-carbon-medium": GEMINI_4_CARBON_CARD,
  "gemini-4-carbon-high": GEMINI_4_CARBON_CARD,
  "gemini-4-argon-low": GEMINI_4_ARGON_CARD,
  "gemini-4-argon-medium": GEMINI_4_ARGON_CARD,
  "gemini-4-argon-high": GEMINI_4_ARGON_CARD,
  "gemini-4-hydrogen-low": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-medium": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-high": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-xhigh": GEMINI_4_HYDROGEN_CARD,
  // T3's tiered-* variants request tiered thinking budgets; same token card.
  "gemini-4-hydrogen-tiered-low": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-tiered-medium": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-tiered-high": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-tiered-xhigh": GEMINI_4_HYDROGEN_CARD,
  "gemini-4-hydrogen-orchestrator": GEMINI_4_HYDROGEN_CARD,
  // Role ids observed in real ACP transcripts: planners report
  // gemini-pro-orchestrator-neon (served by Neon) and executors report
  // gemini-flash-worker-agy (served by Hydrogen); the g1-pro route maps to
  // Argon. The generic `antigravity-default` route is unpriced (null).
  "gemini-pro-orchestrator-neon": GEMINI_4_NEON_CARD,
  "gemini-pro-orchestrator-g1-pro": GEMINI_4_ARGON_CARD,
  "gemini-flash-worker-agy": GEMINI_4_HYDROGEN_CARD,
  "gemini-3.8-flash-low": GEMINI_3_X_FLASH_CARD,
  "gemini-3.8-flash-medium": GEMINI_3_X_FLASH_CARD,
  "gemini-3.8-flash-high": GEMINI_3_X_FLASH_CARD,
  "gemini-3.7-flash-low": GEMINI_3_X_FLASH_CARD,
  "gemini-3.7-flash-medium": GEMINI_3_X_FLASH_CARD,
  "gemini-3.7-flash-high": GEMINI_3_X_FLASH_CARD,
  "gemini-3.6-flash-low": GEMINI_3_X_FLASH_CARD,
  "gemini-3.6-flash-medium": GEMINI_3_X_FLASH_CARD,
  "gemini-3.6-flash-high": GEMINI_3_X_FLASH_CARD,
  "gemini-3.1-pro": GEMINI_3_1_PRO_CARD,
  "gemini-3.1-pro-preview": GEMINI_3_1_PRO_CARD,
  "gemini-3.1-pro-low": GEMINI_3_1_PRO_CARD,
  "gemini-3.1-pro-medium": GEMINI_3_1_PRO_CARD,
  "gemini-3.1-pro-high": GEMINI_3_1_PRO_CARD,
  // Legacy Antigravity alias that served gemini-3.1-pro at the high tier.
  "gemini-pro-agent": GEMINI_3_1_PRO_CARD,
  // Antigravity's gpt-oss row uses Groq's hosted reference rate because the
  // model has no OpenAI first-party API price card; not an OpenAI list price.
  "gpt-oss-120b": GPT_OSS_120B_CARD,
  "gpt-oss-120b-low": GPT_OSS_120B_CARD,
  "gpt-oss-120b-medium": GPT_OSS_120B_CARD,
  "gpt-oss-120b-high": GPT_OSS_120B_CARD,
  // Mistral Large 4 standard list price; its two-week launch discount has ended.
  "mistral-large-4": { inputPer1M: 1.36, outputPer1M: 4.18, cacheReadPer1M: 0.14, cacheWritePer1M: 0 },
  "deepseek-v4-flash": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  // Official API serves it as `deepseek-flash`; same rate card as v4-flash.
  "deepseek-v4.1-flash": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  // Dynamic-rate panel snapshot 2026-10-20 (group default, endpoint openai):
  // 1017 dated snapshot billed at the panel's current-period rates.
  "deepseek-v4.1-flash-1017": {
    inputPer1M: 0.294118,
    outputPer1M: 1.1765,
    cacheReadPer1M: 0.029412,
    cacheWritePer1M: 0
  },
  // Current official model id for v4.1-flash, and the 0731 dated snapshot of v4-flash.
  "deepseek-flash": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  // Singapore-channel slug of v4.1-flash (same credits multiplier, same card).
  "deepseek-v4.1-flash-sg": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  "deepseek-v4-flash-0731": {
    inputPer1M: 0.3,
    outputPer1M: 1.2,
    cacheReadPer1M: 0.006,
    cacheWritePer1M: 0
  },
  "deepseek-v4-pro": {
    inputPer1M: 1.32,
    outputPer1M: 3.96,
    cacheReadPer1M: 0.044,
    cacheWritePer1M: 0
  },
  // platform.kimi.ai: input $3, cached input $0.30, cache write 5min $3 (1h $6), output $15.
  // K3.1 Pro uses the 5-minute cache write rate; Highspeed keeps the same cache-hit rate.
  "kimi-k3.1-pro": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, cacheWritePer1M: 2 },
  "kimi-k3.1-pro-highspeed": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 4 },
  // Kimi Code uses shorter model IDs for these same variants.
  "k3.1-pro": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, cacheWritePer1M: 2 },
  "k3.1-pro-highspeed": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 4 },
  "kimi-k3": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3 },
  "k3-256k": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3 },
  "k3": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3 },
  // WorkBuddy's current K3 slug; same rate card as kimi-k3.
  "kimi-k3-2": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3 },
  "kimi-k3-1": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3 },
  // Official dynamic price table verified in browser 2026-10-23:
  // https://platform.kimi.ai/docs/pricing/chat
  "kimi-k2.7-code": { inputPer1M: 0.95, outputPer1M: 4, cacheReadPer1M: 0.19, cacheWritePer1M: 0 },
  // Official HighSpeed row: input $1.90, output $8, cache read $0.38.
  "kimi-k2.7-code-highspeed": { inputPer1M: 1.9, outputPer1M: 8, cacheReadPer1M: 0.38, cacheWritePer1M: 0 },
  // WorkBuddy's bare K2.7 slug is the same model as kimi-k2.7-code.
  "kimi-k2.7": { inputPer1M: 0.95, outputPer1M: 4, cacheReadPer1M: 0.19, cacheWritePer1M: 0 },
  // K2.6: platform.kimi.ai lists $0.95 uncached / $0.16 cached / $4 output.
  "kimi-k2.6": { inputPer1M: 0.95, outputPer1M: 4, cacheReadPer1M: 0.16, cacheWritePer1M: 0 },
  // K2.5 trackers disagree ($0.49/$2.50 with $0.095 cached vs $0.60/$3.00 with
  // $0.10 cached); the lower, cache-explicit card is used here.
  "kimi-k2.5": { inputPer1M: 0.49, outputPer1M: 2.5, cacheReadPer1M: 0.095, cacheWritePer1M: 0 },
  "kimi-k2-thinking": { inputPer1M: 0.6, outputPer1M: 2.5, cacheReadPer1M: 0.15, cacheWritePer1M: 0 },
  // Kimi-K2 (0905 exacto), exposed by WorkBuddy as kimi-k2-instruct-taiji.
  "kimi-k2-instruct-taiji": { inputPer1M: 0.6, outputPer1M: 2.5, cacheReadPer1M: 0.15, cacheWritePer1M: 0 },
  "kimi-k2": { inputPer1M: 0.6, outputPer1M: 2.5, cacheReadPer1M: 0.15, cacheWritePer1M: 0 },
  // $1/$4, cache read $0.25 (Tencent Cloud's Moonshot listing matches B.AI).
  "kimi-k2.8-preview": { inputPer1M: 1, outputPer1M: 4, cacheReadPer1M: 0.25, cacheWritePer1M: 0 },
  // Kimi Code subscription alias — sold per seat with a quota pool, never per
  // token (official: "Kimi API 按量计费…请注意与 Kimi Code 等产品区分"). Since
  // 2026-09-11 the alias serves K2.8 Preview with the model id unchanged, so the
  // K2.8 Preview rate is the reference estimate. The alias itself still resolves
  // to K2.8 Preview as of 2026-10-24; K3.1 Pro ships under its own ids above.
  "kimi-for-coding": { inputPer1M: 1, outputPer1M: 4, cacheReadPer1M: 0.25, cacheWritePer1M: 0 },
  "kimi-for-coding-highspeed": { inputPer1M: 1.9, outputPer1M: 8, cacheReadPer1M: 0.38, cacheWritePer1M: 0 },
  // Cursor's first-party Composer model, sold per token at cursor.com/docs/models
  // (snapshot 2026-10-27): $0.5/$2.5 standard, $3/$15 for the Fast variant, with
  // no separate cache-write rate ("-" in Cursor's table).
  "composer-2.5": { inputPer1M: 0.5, outputPer1M: 2.5, cacheReadPer1M: 0.2, cacheWritePer1M: 0 },
  // Cursor's `-fast` suffix for Composer 2.5 is its own price tier (2x input
  // round-tripped to $3/$15), not a speed multiplier on the $0.5/$2.5 row.
  "composer-2.5-fast": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // xAI list price; Cursor-subscription traffic is shown at this reference rate.
  // Effort suffixes (high/xhigh/medium/low) never change the per-token rate.
  "grok-4.7": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  "grok-4.7-high": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // Cursor's Fast speed tier is 2x standard ($4/$12/$1 per Cursor's model page),
  // so `high` + `fast` carries both the effort suffix and the accelerated card.
  "grok-4.7-high-fast": { inputPer1M: 4, outputPer1M: 12, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  // Additional Cursor routing variants verified 2026-10-23.
  "grok-4.7-fast": { inputPer1M: 4, outputPer1M: 12, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  "grok-4.6-fast": { inputPer1M: 4, outputPer1M: 12, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  "grok-4.6-high-fast": { inputPer1M: 4, outputPer1M: 12, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  "grok-4.5-fast": { inputPer1M: 4, outputPer1M: 18, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  "grok-4.5-high-fast": { inputPer1M: 4, outputPer1M: 18, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  // 4.5 and 4.6 share the same $2/$6 card (xAI kept pricing flat across both).
  "grok-4.6": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  "grok-4.6-high": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // Cursor's Grok 4.6 ids carry the effort suffix without the Fast tier; the
  // suffix never moves Cursor's price, so this is the standard $2/$6 card.
  "cursor-grok-4.6-high": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  // Cursor Grok 4.6 Fast: published additional-usage rate, USD per 1M tokens.
  "cursor-grok-4.6-high-fast": { inputPer1M: 4, outputPer1M: 12, cacheReadPer1M: 1, cacheWritePer1M: 0 },
  "grok-4.5": { inputPer1M: 2, outputPer1M: 6, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  "minimax-m3.1-flash": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.015, cacheWritePer1M: 0 },
  "minimax-m3": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.06, cacheWritePer1M: 0 },
  // WorkBuddy's metered M3 alias; same <=512K tier as minimax-m3.
  "minimax-m3-pay": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.06, cacheWritePer1M: 0 },
  // M2.7 / M2.5 from platform.minimax.io (cache write is billed at $0.375/1M);
  // highspeed doubles input and output only.
  "minimax-m2.7": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.06, cacheWritePer1M: 0.375 },
  "minimax-m2.7-highspeed": { inputPer1M: 0.6, outputPer1M: 2.4, cacheReadPer1M: 0.06, cacheWritePer1M: 0.375 },
  "minimax-m2.5": { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.03, cacheWritePer1M: 0.375 },
  "minimax-m2.5-highspeed": { inputPer1M: 0.6, outputPer1M: 2.4, cacheReadPer1M: 0.03, cacheWritePer1M: 0.375 },
  // mimo.mi.com overseas rate card (verified 2026-10-09); cache writes are
  // free for a limited time per the official docs.
  "mimo-v2.6-flash": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028, cacheWritePer1M: 0 },
  "mimo-v2.6-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cacheReadPer1M: 0.0036, cacheWritePer1M: 0 },
  "mimo-v2.6-pro-ultraspeed": { inputPer1M: 4.35, outputPer1M: 8.7, cacheReadPer1M: 0.036, cacheWritePer1M: 0 },
  // v2.5 rows retire 2026-10-21; v2.6 kept the same rates.
  "mimo-v2.5": { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.0028, cacheWritePer1M: 0 },
  "mimo-v2.5-pro": {
    inputPer1M: 0.435,
    outputPer1M: 0.87,
    cacheReadPer1M: 0.0036,
    cacheWritePer1M: 0
  },
  // Retired; requests are forwarded to mimo-v2.5-pro and billed at its rates.
  "mimo-v2-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cacheReadPer1M: 0.0036, cacheWritePer1M: 0 },
  // MiMo Desktop subscription alias; the app serves mimo-v2.6-pro behind it,
  // so that rate card is the reference estimate.
  "mimo-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cacheReadPer1M: 0.0036, cacheWritePer1M: 0 },
  // Tencent Hunyuan rows (WorkBuddy's own family). CNY per 1M tokens divided by
  // 7.194, the rate Tencent publishes on its Token Plan page (CNY 6 -> $0.834).
  // hy.tencent.com: Hy4 preview = input 6 / output 18 / cache-hit 0.3 CNY.
  "hy4-preview": { inputPer1M: 0.834, outputPer1M: 2.501, cacheReadPer1M: 0.042, cacheWritePer1M: 0 },
  // WorkBuddy's "-x" slugs are the same model ids routed through another channel.
  "hy4-preview-x": { inputPer1M: 0.834, outputPer1M: 2.501, cacheReadPer1M: 0.042, cacheWritePer1M: 0 },
  // cloud.tencent.com Token Plan: Hy3 = input 1 / output 4 / cache 0.25 CNY.
  "hy3": { inputPer1M: 0.139, outputPer1M: 0.556, cacheReadPer1M: 0.035, cacheWritePer1M: 0 },
  "hy3-x": { inputPer1M: 0.139, outputPer1M: 0.556, cacheReadPer1M: 0.035, cacheWritePer1M: 0 },
  // WorkBuddy legacy Claude aliases (default-1.1 = Claude-3.7-Sonnet,
  // default-1.2 = Claude-4.0-Sonnet); priced at Sonnet's standard card.
  "default-1.1": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "default-1.2": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-3.7-sonnet": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-4.0-sonnet": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  // Free model served by opencode.
  "big-pickle": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "deepseek-v4-flash-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "hy3-preview-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  "mimo-v2-pro-free": { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 }
  // "hy3-preview" (no -free suffix) is intentionally absent: no published list
  // price, so lookups return null. "mimo-auto" is a router alias billed at
  // whichever model it lands on, so it has no list price of its own either.
  // WorkBuddy's `hunyuan-chat` (Hunyuan-Turbos) and `hunyuan-2.0-*` rows are
  // absent for the same reason: no per-token list price is published.
};

// Official sources fetched 2026-10-23. Short-context, default residency,
// shortest cache-write TTL only; reference estimates, never subscription bills.
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
// https://cursor.com/docs/models-and-pricing
export const FAST_MODEL_PRICING_USD: Record<string, ModelPricing> = {
  "gpt-6.2-astra": { inputPer1M: 16, outputPer1M: 80, cacheReadPer1M: 0.8, cacheWritePer1M: 20 },
  "gpt-6.2-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 5 },
  "gpt-6-astra": { inputPer1M: 20, outputPer1M: 100, cacheReadPer1M: 2, cacheWritePer1M: 25 },
  "gpt-6.1-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.2, cacheWritePer1M: 5 },
  "gpt-6.1-terra": { inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.1, cacheWritePer1M: 2.5 },
  "gpt-6-sol": { inputPer1M: 4, outputPer1M: 20, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
  "gpt-6-luna": { inputPer1M: 0.2, outputPer1M: 1, cacheReadPer1M: 0.02, cacheWritePer1M: 0.25 },
  "gpt-5.6-sol": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.8, cacheWritePer1M: 10 },
  "gpt-5.6-terra": { inputPer1M: 4, outputPer1M: 24, cacheReadPer1M: 0.4, cacheWritePer1M: 5 },
  "gpt-5.6-luna": { inputPer1M: 0.4, outputPer1M: 2.4, cacheReadPer1M: 0.04, cacheWritePer1M: 0.5 },
  "gpt-5.5": { inputPer1M: 12.5, outputPer1M: 75, cacheReadPer1M: 1.25, cacheWritePer1M: 0 },
  "gpt-5.4": { inputPer1M: 5, outputPer1M: 30, cacheReadPer1M: 0.5, cacheWritePer1M: 0 },
  "gpt-5.4-mini": { inputPer1M: 1.5, outputPer1M: 9, cacheReadPer1M: 0.15, cacheWritePer1M: 0 },
  "gpt-5.3-codex": { inputPer1M: 3.5, outputPer1M: 28, cacheReadPer1M: 0.35, cacheWritePer1M: 0 },
  "claude-opus-5-5": { inputPer1M: 8, outputPer1M: 40, cacheReadPer1M: 0.4, cacheWritePer1M: 10 },
  "claude-opus-5": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "claude-opus-5-thinking-high": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "claude-opus-4-8": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  // T3's model manifest exposes an explicit fastMode flag on the claudeAgent
  // opus-4-6 profile; Anthropic fast mode doubles the Opus card (same as 4.8).
  "claude-opus-4-6": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  "grok-4.7": MODEL_PRICING_USD["grok-4.7-fast"]!,
  "grok-4.7-high": MODEL_PRICING_USD["grok-4.7-fast"]!,
  "grok-4.6": MODEL_PRICING_USD["grok-4.6-fast"]!,
  "grok-4.6-high": MODEL_PRICING_USD["grok-4.6-high-fast"]!,
  "grok-4.5": MODEL_PRICING_USD["grok-4.5-fast"]!,
  "composer-2.5": MODEL_PRICING_USD["composer-2.5-fast"]!
};

export const ULTRAFAST_MODEL_PRICING_USD: Record<string, ModelPricing> = {
  // GPT-6.2 launch rates are 3x through 2027-02-28 Pacific time. List rates are 6x from 2027-03-01.
  "gpt-6.2-astra": { inputPer1M: 24, outputPer1M: 120, cacheReadPer1M: 1.2, cacheWritePer1M: 30 },
  "gpt-6.2-sol": { inputPer1M: 6, outputPer1M: 30, cacheReadPer1M: 0.3, cacheWritePer1M: 7.5 },
  "gpt-6-astra": { inputPer1M: 60, outputPer1M: 300, cacheReadPer1M: 6, cacheWritePer1M: 75 },
  "gpt-6.1-sol": { inputPer1M: 12, outputPer1M: 60, cacheReadPer1M: 0.6, cacheWritePer1M: 15 }
};

/**
 * Speed/service-tier multipliers applied on top of the list rate. A "fast mode"
 * is the same model served by a higher-priority inference configuration, so the
 * tokens are identical but the provider bills them at a multiple:
 *
 *   - OpenAI (Codex, API): explicit Fast and Ultrafast price cards take precedence.
 *     `priority` resolves to Fast; `flex` (batch-style queue) is ~0.5x.
 *     learn.chatgpt.com/docs/agent-configuration/speed, codex.danielvaughan.com
 *   - Anthropic (Claude Code `/fast`): Opus 5.5 $8/$40 and Opus 5 / 4.8 $10/$50,
 *     i.e. 2x the standard Opus rates, with prompt-caching rates scaled too.
 *     platform.claude.com/docs/en/docs/build-with-claude/fast-mode
 *
 * Models that already publish an accelerated card as their own model id
 * (`kimi-for-coding-highspeed`, `mimo-v2.6-pro-ultraspeed`,
 * `minimax-m2.5-highspeed`, Cursor's `-fast` variants) must NOT also set a tier:
 * their multiplier is baked into the row above.
 */
export const SERVICE_TIER_MULTIPLIERS: Record<string, number> = {
  standard: 1,
  flex: 0.5,
  fast: 2,
  priority: 2,
  ultrafast: 6
};

/**
 * Canonical form of a service tier, or null when the usage is billed at the
 * model's stock rate. `standard` is normalized to null so a source that spells
 * out the default tier groups with the rows that omit it. Unknown tiers keep
 * their own value: they still surface as a separate row (billed at 1x, see
 * {@link serviceTierMultiplier}) instead of silently merging into standard.
 */
export function normalizeServiceTier(tier: string | null | undefined): string | null {
  const key = tier?.trim().toLowerCase();
  if (!key || key === "standard") {
    return null;
  }
  return key;
}

/**
 * Resolve a service tier to its billing multiplier. Unknown or absent tiers are
 * billed at the standard rate rather than guessed at, so an unrecognized value
 * can only ever under-report the surcharge, never invent one.
 */
export function serviceTierMultiplier(tier: string | null | undefined): number {
  const key = normalizeServiceTier(tier);
  if (!key) {
    return 1;
  }
  return SERVICE_TIER_MULTIPLIERS[key] ?? 1;
}

// These providers encode reasoning effort in the model ID. Other models can
// use the same words as part of a distinct model name (e.g. Qwen Max).
const MODELS_WITH_EFFORT_SUFFIX = new Set([
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5",
  "gemini-4-carbon", "gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen",
  "gemini-3.8-flash", "gemini-3.6-flash",
  "grok-4.5", "grok-4.6", "grok-4.7", "gpt-5.6-luna"
]);
const EFFORT_SUFFIX = /^(.+?)-(?:thinking-)?(low|medium|high|xhigh|max)(?:-thinking)?(-fast)?$/;

function lookupModelPricing(record: Record<string, ModelPricing>, key: string): ModelPricing | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function resolveModelPriceKey(modelKey: string): string {
  if (Object.hasOwn(MODEL_PRICING_USD, modelKey)) {
    return modelKey;
  }

  const normalized = modelKey.replace(/^claude-4[.-]6-(opus|sonnet)(?=-|$)/, "claude-$1-4-6");
  const match = EFFORT_SUFFIX.exec(normalized);
  if (match) {
    const [, baseModel, effort, speed = ""] = match;
    if (MODELS_WITH_EFFORT_SUFFIX.has(baseModel) && (effort !== "max" || baseModel === "gpt-5.6-luna")) {
      return baseModel + speed;
    }
  }
  return normalized;
}

/**
 * Estimate the USD cost of one usage row. `inputTokens` MUST already be the
 * displayed input (gross-semantic sources have cache-read subtracted) because
 * cache reads are priced separately. Returns null when the model has no
 * published price.
 *
 * `serviceTier` applies the accelerated-speed multiplier (see
 * {@link SERVICE_TIER_MULTIPLIERS}); omit it for standard-priced usage.
 *
 * Sources report provider-prefixed ids (OpenRouter-style "vendor/model", e.g.
 * "kimi-code/k3-256k"); fall back to the bare id after the last slash when the
 * full string has no entry.
 */
export function estimateCostUsd(usage: {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  serviceTier?: string | null;
  usageMode?: UsageMode;
}): number | null {
  const key = normalizeModelId(usage.model)?.toLowerCase();
  if (!key) {
    return null;
  }

  const bareKey = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  const modelKey = bareKey.startsWith("cursor-") ? bareKey.slice(7) : bareKey;
  const mode = usage.usageMode ?? resolveUsageMode(modelKey, usage.serviceTier);
  const namedFast = resolveUsageMode(modelKey) === "fast";
  let pricing = mode === "ultrafast"
    ? lookupModelPricing(ULTRAFAST_MODEL_PRICING_USD, modelKey.replace(/-ultrafast$/u, ""))
    : mode === "fast"
      ? lookupModelPricing(FAST_MODEL_PRICING_USD, modelKey) ??
        (namedFast ? lookupModelPricing(MODEL_PRICING_USD, modelKey) : undefined)
      : lookupModelPricing(MODEL_PRICING_USD, key) ?? lookupModelPricing(MODEL_PRICING_USD, modelKey);
  if (!pricing) {
    const resolvedKey = resolveModelPriceKey(modelKey);
    pricing = mode === "ultrafast"
      ? lookupModelPricing(ULTRAFAST_MODEL_PRICING_USD, resolvedKey.replace(/-ultrafast$/u, ""))
      : mode === "fast"
        ? lookupModelPricing(FAST_MODEL_PRICING_USD, resolvedKey) ??
          lookupModelPricing(FAST_MODEL_PRICING_USD, resolvedKey.replace(/-fast$/u, "")) ??
          (namedFast ? lookupModelPricing(MODEL_PRICING_USD, resolvedKey) : undefined)
        : lookupModelPricing(MODEL_PRICING_USD, resolvedKey);
  }
  if (!pricing) {
    return null;
  }

  const standardCost =
    (usage.inputTokens * pricing.inputPer1M +
      usage.outputTokens * pricing.outputPer1M +
      usage.cacheReadTokens * pricing.cacheReadPer1M +
      usage.cacheCreationTokens * pricing.cacheWritePer1M) /
    1e6;

  // Accelerated cards already include their surcharge, including named speed
  // variants. Only non-speed tiers (for example flex) need a multiplier here.
  return standardCost * (mode === "fast" || mode === "ultrafast" ? 1 : serviceTierMultiplier(usage.serviceTier));
}
