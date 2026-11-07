import { ScannerChecks } from './scanner-checks';
import { ScannerGrades } from './scanner-grades';
import { ScannerLimits } from './scanner-limits';

export function ScannerGuideContent() {
  return <><ScannerGrades /><ScannerChecks /><ScannerLimits /></>;
}
