// Merriam-Webster's inline markup ({bc}, {it}…{/it}, {sx|word||}, …) to plain text.
// Reference: https://dictionaryapi.com/products/json#sec-2.tokens
const LINK = /\{(?:sx|a_link|d_link|i_link|et_link|mat|dxt)\|([^|}]*)[^}]*\}/g;

export function stripMarkup(input) {
  return String(input ?? '')
    .replace(/\{dx\}.*?\{\/dx\}/g, '')        // "see also" cross-reference blocks
    .replace(/\{dx_def\}.*?\{\/dx_def\}/g, '')
    .replace(/\{ds\|[^}]*\}/g, '')             // date sense numbers, e.g. 1576{ds||2||}
    .replace(/^\s*\{bc\}/, '')                 // leading bold colon
    .replace(/\{bc\}/g, ': ')
    .replace(/\{(?:ldquo|rdquo)\}/g, '"')
    // Link text can carry a homograph number ("{sx|degrading:1|…}" → "degrading").
    .replace(LINK, (_, word) => word.replace(/:\d+$/, ''))
    .replace(/\{[^}]*\}/g, '')                 // any remaining formatting tags
    .replace(/\s+([,;:.])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// https://dictionaryapi.com/products/json#sec-2.prs
export function audioUrl(audio) {
  if (!audio) return null;
  const sub = audio.startsWith('bix') ? 'bix'
    : audio.startsWith('gg') ? 'gg'
    : /^[^a-z]/i.test(audio) ? 'number'
    : audio[0];
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${sub}/${encodeURIComponent(audio)}.mp3`;
}
