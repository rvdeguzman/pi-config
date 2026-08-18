import { compact } from '../store/records';

const JOBS = [
  { at: '0 3 * * *', run: () => compact('current', 'daily') },
  { at: '0 4 * * 0', run: () => compact('daily', 'weekly') },
];

export function startScheduler() {
  for (const job of JOBS) schedule(job.at, job.run);
}

function schedule(_expr: string, _fn: Function) {}
