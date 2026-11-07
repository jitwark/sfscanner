import { createHash } from 'node:crypto';

export const protocolSplits = ['development', 'holdout'];
export const protocolFields = ['tuningSplit', 'holdoutSplit', 'holdoutPolicy', 'queryKey', 'developmentQuerySetSha256', 'holdoutQuerySetSha256'];
export const caseKey = (testCase) => JSON.stringify([
  testCase.query,
  Object.fromEntries(Object.entries(testCase.filters ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])),
  testCase.sort,
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const querySetHash = (cases, split) => createHash('sha256')
  .update(cases.filter((testCase) => isRecord(testCase) && testCase.split === split).map(caseKey).sort().join('\n'))
  .digest('hex');

export function validateBenchmarkProtocol({ report, fixture, cases, errors }) {
  const protocol = fixture.protocol;
  if (!isRecord(protocol) || protocol.tuningSplit !== 'development' || protocol.holdoutSplit !== 'holdout'
    || protocol.holdoutPolicy !== 'untouched-evaluate-once' || protocol.queryKey !== 'query+filters+sort-v1') {
    errors.push('fixture holdout protocol is missing or invalid');
    return;
  }
  for (const split of protocolSplits) {
    const field = `${split}QuerySetSha256`;
    if (protocol[field] !== querySetHash(cases, split)) errors.push(`fixture ${field} is stale`);
  }
  if (!isRecord(report.protocol)) errors.push('report holdout protocol is missing');
  else for (const field of protocolFields) if (report.protocol[field] !== protocol[field]) errors.push(`report.protocol.${field} does not match the fixture`);
}
