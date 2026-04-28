import type { PageName } from "@/config/debounce";
import { getSearchPendingOpacity } from "@/config/debounce";

export function searchPendingClass(isPending: boolean, page?: PageName): string {
  if (isPending) {
    const opacity = page ? getSearchPendingOpacity(page) : 'opacity-60';
    return `transition-opacity duration-200 ${opacity}`;
  }
  return 'transition-opacity duration-200';
}
