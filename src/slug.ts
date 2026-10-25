/** a short name from words, for a branch or a run: lowercase, plain letters, cut at a word to 40 characters */
export function slug(text: string): string {
  const s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length <= 40) return s
  const cut = s.slice(0, 41)
  return (cut.lastIndexOf('-') > 10 ? cut.slice(0, cut.lastIndexOf('-')) : s.slice(0, 40)).replace(/-+$/, '')
}
