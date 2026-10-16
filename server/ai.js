// Optional AI explanations of how two words differ. Two providers, each used with the
// person's own key (Settings → AI explanations, or .env):
//   groq       free plan, no card (an open model hosted by Groq)
//   anthropic  Claude, paid per use
import Anthropic from '@anthropic-ai/sdk';

const MAX_DEFINITIONS_PER_WORD = 8;
const MAX_SYNONYMS_PER_WORD = 20;
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `You are a lexicographer helping a reader who keeps a personal vocabulary notebook.
Given dictionary profiles of two words or phrases, explain how they differ in meaning, connotation, register, and typical usage.

Write plain text with no markdown, headings, bullet characters, or bold. Keep it under 150 words, in this shape:
- One sentence stating the core difference.
- A line starting "Use <first term> when" and a line starting "Use <second term> when".
- One natural example sentence for each term, each on its own line, starting "Example:".
If the two are nearly interchangeable, say so plainly and name the subtle difference that remains. If they are unrelated, say that briefly and explain each one's meaning.`;

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function describe(profile) {
  const lines = [`Term: ${profile.term}`];
  if (profile.partsOfSpeech?.length) lines.push(`Parts of speech: ${profile.partsOfSpeech.join(', ')}`);
  profile.definitions.slice(0, MAX_DEFINITIONS_PER_WORD).forEach((d, i) => {
    const example = d.examples?.[0] ? ` (e.g. "${d.examples[0]}")` : '';
    lines.push(`${i + 1}. ${d.part_of_speech ? `[${d.part_of_speech}] ` : ''}${d.text}${example}`);
  });
  if (!profile.definitions.length) lines.push('(No dictionary definition available.)');
  if (profile.synonyms?.length) lines.push(`Synonyms: ${profile.synonyms.slice(0, MAX_SYNONYMS_PER_WORD).join(', ')}`);
  if (profile.antonyms?.length) lines.push(`Antonyms: ${profile.antonyms.slice(0, MAX_SYNONYMS_PER_WORD).join(', ')}`);
  return lines.join('\n');
}

function userMessage([a, b], discussion) {
  const parts = [describe(a), describe(b)];
  if (discussion) parts.push(`Merriam-Webster's synonym discussion:\n${discussion}`);
  parts.push(`Explain how "${a.term}" and "${b.term}" differ.`);
  return parts.join('\n\n');
}

// ----- Groq (free plan; OpenAI-compatible API) -----

const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Groq retires models from time to time; GROQ_MODEL in .env overrides the default.
const groqModel = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

async function groqRequest(apiKey, path, init = {}) {
  let res;
  try {
    res = await fetch(`${GROQ_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AiError(err?.name === 'TimeoutError'
      ? 'Groq took too long to answer. Try again.'
      : 'Couldn’t reach Groq. Check your internet connection.', 503);
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return body;

  const message = body?.error?.message ?? '';
  const code = body?.error?.code ?? '';
  if (res.status === 401) throw new AiError('Groq didn’t accept the API key. Check it in Settings.', 400);
  if (res.status === 429) throw new AiError('Groq’s free limit is used up for now. Try again later.', 429);
  const modelGone = res.status === 404 || /model_(not_found|decommissioned)/.test(code)
    || (/model/i.test(message) && /decommission|not exist|not found/i.test(message));
  if (modelGone) {
    throw new AiError(`Groq no longer offers the model “${groqModel()}”. Update Word Collector, or set GROQ_MODEL in .env.`, 502);
  }
  throw new AiError(`Groq: ${message || `error ${res.status}`}`, res.status >= 500 ? 502 : 400);
}

const groq = {
  id: 'groq',
  label: 'Groq',
  model: groqModel,
  async explain(apiKey, profiles, discussion) {
    const body = await groqRequest(apiKey, '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: groqModel(),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage(profiles, discussion) },
        ],
        // A reasoning model: keep its reasoning short and out of the answer text.
        reasoning_effort: 'low',
        include_reasoning: false,
        max_completion_tokens: 2000,
      }),
    });
    const choice = body?.choices?.[0];
    const text = String(choice?.message?.content ?? '').trim();
    if (!text) {
      throw new AiError(choice?.finish_reason === 'length'
        ? 'The explanation was cut off. Try again.'
        : 'Groq returned an empty explanation. Try again.');
    }
    return { text, model: body.model ?? groqModel() };
  },
  // Listing models is free and confirms the key works.
  async testKey(apiKey) {
    try {
      await groqRequest(apiKey, '/models');
      return { ok: true };
    } catch (err) {
      return { ok: false, invalidKey: /didn’t accept/.test(err.message), message: err.message };
    }
  },
};

// ----- Anthropic (Claude, paid per use) -----

const CLAUDE_MODEL = 'claude-opus-5-5';

// Always pass the key explicitly (and no auth token), so a credential that happens to be
// set elsewhere on this computer is never used by accident.
const claudeClient = (apiKey) => new Anthropic({ apiKey, authToken: null, maxRetries: 2, timeout: TIMEOUT_MS });

function toClaudeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AiError('Anthropic didn’t accept the API key. Check it in Settings.', 400);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('This Anthropic API key doesn’t have access to the model.', 400);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiError('Claude is busy right now. Try again in a minute.', 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    // e.g. the account's credit balance is too low; the API's message says what to do.
    return new AiError(`Anthropic: ${err.error?.error?.message ?? err.message}`, 400);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiError('Couldn’t reach Anthropic. Check your internet connection.', 503);
  }
  if (err instanceof Anthropic.APIError) {
    return new AiError(`Anthropic error (${err.status ?? 'unknown'}). Try again later.`);
  }
  return err;
}

const anthropic = {
  id: 'anthropic',
  label: 'Claude',
  model: () => CLAUDE_MODEL,
  async explain(apiKey, profiles, discussion) {
    let response;
    try {
      response = await claudeClient(apiKey).beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        // A short explanation doesn't need deep reasoning; thinking stays at the model default.
        output_config: { effort: 'low' },
        // If this model declines, the API retries on a suitable fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: userMessage(profiles, discussion) }],
      });
    } catch (err) {
      throw toClaudeError(err);
    }
    if (response.stop_reason === 'refusal') {
      throw new AiError('Claude didn’t explain this pair.', 422);
    }
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!text) throw new AiError('Claude returned an empty explanation. Try again.');
    return { text, model: response.model ?? CLAUDE_MODEL };
  },
  // A free call that confirms the key works (no tokens are used).
  async testKey(apiKey) {
    try {
      await claudeClient(apiKey).models.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, invalidKey: err instanceof Anthropic.AuthenticationError, message: toClaudeError(err).message };
    }
  },
};

export const AI_PROVIDERS = { groq, anthropic };

// profiles: both sides' { term, partsOfSpeech, definitions, synonyms, antonyms }.
// discussion: Merriam-Webster's synonym discussion text when it covers the pair.
export function explainDifference(providerId, apiKey, profiles, discussion) {
  return AI_PROVIDERS[providerId].explain(apiKey, profiles, discussion);
}
