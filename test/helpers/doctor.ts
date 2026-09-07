import type { DoctorReport } from '../../src/checks/report.js';

/** The finding ids on a report, in order, for concise assertions in tests. */
export function findingIds(report: DoctorReport): string[] {
  return report.findings.map((f) => f.id);
}
