export const DEFAULT_CANCEL_CONFIRM_THRESHOLD = 75;

export interface BuildProgressState {
  current: number;
  total: number;
  step: number;
  totalSteps: number;
}

export function computeOverallProgress(progress: BuildProgressState): number {
  const { current, total, step, totalSteps } = progress;
  if (totalSteps <= 0 || step <= 0) return 0;
  const stepFraction = total > 0 ? current / total : 0;
  return ((step - 1 + stepFraction) / totalSteps) * 100;
}

export type CancelAction = 'show_confirm' | 'abort' | 'noop';

export function decideCancelAction(
  hasAbortController: boolean,
  overallProgress: number,
  threshold: number = DEFAULT_CANCEL_CONFIRM_THRESHOLD,
): CancelAction {
  if (!hasAbortController) return 'noop';
  if (threshold === 0 || overallProgress >= threshold) return 'show_confirm';
  return 'abort';
}
