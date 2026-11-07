function blank(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

export function maskReviewedParserProcessShim(source) {
  // This exact process/browser wrapper comes from @lezer/lr's optional
  // process.env.LOG parser-tracing check. Leave every other access auditable.
  const chars = source.split('');
  const wrapper = /\bvar\s+(\w+),(\w+);t\.exports=\(null==\(\1=(\w+)\.g\.process\)\?void 0:\1\.env\)&&"object"==typeof\(null==\(\2=\3\.g\.process\)\?void 0:\2\.env\)\?\3\.g\.process:\3\(\d+\)/g;
  for (const match of source.matchAll(wrapper)) blank(chars, match.index, match.index + match[0].length);
  return chars.join('');
}
