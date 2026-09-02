import { useHashLocation } from 'wouter/use-hash-location';
import { useBrowserLocation } from 'wouter/use-browser-location';

export function isElectronFileMode(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

const IS_FILE_PROTOCOL = isElectronFileMode();

export function useAdaptiveLocation(): [string, (to: string) => void] {
  if (IS_FILE_PROTOCOL) {
    const [path, navigate] = useHashLocation();
    return [path, (to: string) => navigate(to)];
  } else {
    const [path, navigate] = useBrowserLocation();
    return [path, (to: string) => navigate(to)];
  }
}
