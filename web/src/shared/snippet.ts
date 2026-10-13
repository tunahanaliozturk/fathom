// The API's snippets are plain text with each match between « and ». They come from documents other people wrote,
// so they are split into parts here and rendered as text nodes and <mark> elements, never parsed as markup.

export interface Part {
  text: string
  match: boolean
}

// Innermost pairs only. A « or » that does not close properly may be part of the document (French quotation marks),
// so it stays in the text as it is.
const MATCH = /«([^«»]*)»/g

export function parts(snippet: string): Part[] {
  const found: Part[] = []
  let end = 0
  for (const match of snippet.matchAll(MATCH)) {
    if (match.index > end) found.push({ text: snippet.slice(end, match.index), match: false })
    const inner = match[1] ?? ''
    if (inner !== '') found.push({ text: inner, match: true })
    end = match.index + match[0].length
  }
  if (end < snippet.length) found.push({ text: snippet.slice(end), match: false })
  return found
}
