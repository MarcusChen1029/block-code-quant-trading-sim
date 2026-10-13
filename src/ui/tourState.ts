import { loadText } from './storage';

export const TOUR_DONE_STORAGE_KEY = 'quant-sim.tour-done.v1';

/** True once the guided tour was finished or skipped (kept apart from tour.ts so that loads only when needed). */
export function tourDone(): boolean {
  return loadText(TOUR_DONE_STORAGE_KEY) === '1';
}
