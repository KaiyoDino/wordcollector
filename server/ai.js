// Optional AI explanations of how two words differ, using Claude with the user's own
// Anthropic API key (Settings → API keys, or ANTHROPIC_API_KEY in .env).
import Anthropic from '@anthropic-ai/sdk';

export const AI_MODEL = 'claude-opus-5-5';
const MAX_DEFINITIONS_PER_WORD = 8;
const MAX_SYNONYMS_PER_WORD = 20;

const SYSTEM_PROMPT = `You are a lexicographer helping a reader who keeps a personal vocabulary notebook.
Given dictionary profiles of two words or phrases, explain how they differ in meaning, connotation, register, and typical usage.

Write plain text with no markdown, headings, bullet characters, or bold. Keep it under 150 words, in this shape:
- One sentence stating the core difference.
- A line starting "Use <first term> when" and a line starting "Use <second term> when".
- One natural example sentence for each term, each on its own line, starting "Example:".
If the two are nearly interchangeable, say so plainly and name the subtle difference that remains. If they are unrelated, say that briefly and explain each one's meaning.`;

class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Always pass the key explicitly (and no auth token), so a credential that happens to be
// set elsewhere on this computer is never used by accident.
const client = (apiKey) => new Anthropic({ apiKey, authToken: null, maxRetries: 2, timeout: 60_000 });

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

// profiles: [{ term, partsOfSpeech, definitions, synonyms, antonyms }] for both words.
// discussion: Merriam-Webster's synonym discussion text when it covers the pair.
export async function explainDifference(apiKey, [a, b], discussion) {
  const parts = [describe(a), describe(b)];
  if (discussion) parts.push(`Merriam-Webster's synonym discussion:\n${discussion}`);
  parts.push(`Explain how "${a.term}" and "${b.term}" differ.`);

  let response;
  try {
    response = await client(apiKey).beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      // A short explanation doesn't need deep reasoning; thinking stays at the model default.
      output_config: { effort: 'low' },
      // If this model declines, the API retries on a suitable fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    });
  } catch (err) {
    throw toAiError(err);
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
  return { text, model: response.model ?? AI_MODEL };
}

// A free call that confirms the key works (no tokens are used).
export async function testAnthropicKey(apiKey) {
  try {
    await client(apiKey).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    const error = toAiError(err);
    return { ok: false, invalidKey: err instanceof Anthropic.AuthenticationError, message: error.message };
  }
}

function toAiError(err) {
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
