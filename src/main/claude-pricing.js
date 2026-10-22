// Anthropic's published API rates, used wherever Token Ledger prices Claude
// usage itself instead of taking ccusage's figure.
//
// USD per million tokens. Anthropic's standard cache multipliers are 0.1x input
// to read, 1.25x to write a 5m entry and 2x for a 1h entry; Fable 5.1 ($0.25)
// and Opus 5.5 ($0.20) publish cheaper reads. If Anthropic changes a rate, edit
// it here.
function rates(input, output, overrides = {}) {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    ...overrides,
  };
}

const PRICING = {
  "claude-fable-5-1": rates(10, 50, { cacheRead: 0.25 }),
  "claude-fable-5": rates(10, 50),
  "claude-mythos-5-1": rates(10, 50, { cacheRead: 0.25 }),
  "claude-opus-5-5": rates(4, 20, { cacheRead: 0.2 }),
  "claude-opus-5": rates(5, 25),
  "claude-opus-4-8": rates(5, 25),
  "claude-opus-4-7": rates(5, 25),
  "claude-sonnet-5-5": rates(2, 10),
  "claude-sonnet-5": rates(2, 10),
  "claude-sonnet-4-6": rates(3, 15),
  "claude-haiku-5-5": rates(0.1, 0.5),
  "claude-haiku-4-5": rates(1, 5),
};

// Haiku 5.5 is the one current model with a long-prompt tier: prompts over
// 100K tokens bill at these rates instead.
const LONG_PROMPT_PRICING = {
  "claude-haiku-5-5": { threshold: 100_000, rates: rates(0.5, 2.5) },
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Transcripts sometimes carry a dated snapshot id (claude-haiku-4-5-20251001).
function baseModelName(modelName) {
  return String(modelName || "").replace(/-\d{8}$/, "");
}

function lookupRates(modelName) {
  return PRICING[modelName] || PRICING[baseModelName(modelName)] || null;
}

// Splits cache writes into 5m and 1h entries. Without a breakdown, assume the
// cheaper 5m entry rather than overcharging.
function cacheWrites(usage) {
  const creation = usage.cache_creation || {};
  const write1h = number(creation.ephemeral_1h_input_tokens);
  const write5m =
    creation.ephemeral_5m_input_tokens === undefined && !creation.ephemeral_1h_input_tokens
      ? number(usage.cache_creation_input_tokens)
      : number(creation.ephemeral_5m_input_tokens);
  return { write5m, write1h };
}

// Returns null when the model has no price on file.
function costOf(modelName, usage) {
  let rate = lookupRates(modelName);
  if (!rate) {
    return null;
  }
  const { write5m, write1h } = cacheWrites(usage);
  const input = number(usage.input_tokens);
  const cacheRead = number(usage.cache_read_input_tokens);
  const longPrompt = LONG_PROMPT_PRICING[baseModelName(modelName)];
  if (longPrompt && input + cacheRead + write5m + write1h > longPrompt.threshold) {
    rate = longPrompt.rates;
  }

  return (
    (input * rate.input +
      number(usage.output_tokens) * rate.output +
      cacheRead * rate.cacheRead +
      write1h * rate.cacheWrite1h +
      write5m * rate.cacheWrite5m) /
    1e6
  );
}

module.exports = {
  PRICING,
  costOf,
  lookupRates,
};
