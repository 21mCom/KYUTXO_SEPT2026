export function searchPendingClass(isPending: boolean): string {
  return isPending
    ? 'transition-opacity duration-200 opacity-60'
    : 'transition-opacity duration-200';
}
