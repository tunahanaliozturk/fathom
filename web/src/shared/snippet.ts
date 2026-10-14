// The API's snippets are plain text with each match between « and ». They come from documents other people wrote,
// so they are split into parts here and rendered as text nodes and <mark> elements, never parsed as markup.

export interface Part {
  text: string
  match: boolean
}

// A match is one token: ts_headline wraps single words, numbers and identifiers, never a run with a space in it. So a
// pair with a space inside, an empty pair, or a « that never closes is the document's own punctuation (French
// quotation marks, or documentation about these very markers) and stays in the text as it is. What cannot be told
// apart is a document that itself contains «word» with no space; that one is shown as a match (ADR 10).
const MATCH = /«([^«»\s]+)»/g

export function parts(snippet: string): Part[] {
  const found: Part[] = []
  let end = 0
  for (const match of snippet.matchAll(MATCH)) {
    if (match.index > end) found.push({ text: snippet.slice(end, match.index), match: false })
    found.push({ text: match[1] ?? '', match: true })
    end = match.index + match[0].length
  }
  if (end < snippet.length) found.push({ text: snippet.slice(end), match: false })
  return found
}
