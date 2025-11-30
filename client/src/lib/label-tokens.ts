/**
 * Label Token Parser
 * 
 * Expands tokens in label templates for bulk imports:
 * - [#] → Sequential number (1, 2, 3...) - auto-pads to match largest number
 * - [date] → Current date in YYYY-MM-DD format
 * - [wallet] → Wallet name value from the form
 * 
 * Example: "Savings-[#]" with 100 items → "Savings-001", "Savings-002", etc.
 */

export interface TokenContext {
  index: number;
  totalCount: number;
  walletName?: string;
  date?: Date;
}

/**
 * Get the number of digits needed to represent the largest number
 */
function getDigitCount(num: number): number {
  if (num <= 0) return 1;
  return Math.floor(Math.log10(num)) + 1;
}

/**
 * Pad a number with leading zeros to match the specified width
 */
function padNumber(num: number, width: number): string {
  return num.toString().padStart(width, '0');
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Expand tokens in a label template
 * 
 * @param template - The label template with tokens like [#], [date], [wallet]
 * @param context - Context for token expansion
 * @returns The expanded label string
 */
export function expandLabelTokens(template: string, context: TokenContext): string {
  if (!template) return template;
  
  const date = context.date || new Date();
  const digitWidth = getDigitCount(context.totalCount);
  
  let result = template;
  
  // Replace [#] with padded sequential number (1-indexed)
  result = result.replace(/\[#\]/g, padNumber(context.index + 1, digitWidth));
  
  // Replace [date] with formatted date
  result = result.replace(/\[date\]/gi, formatDate(date));
  
  // Replace [wallet] with wallet name (or empty string if not provided)
  result = result.replace(/\[wallet\]/gi, context.walletName || '');
  
  return result;
}

/**
 * Check if a template contains any tokens
 */
export function hasTokens(template: string): boolean {
  if (!template) return false;
  return /\[#\]|\[date\]|\[wallet\]/i.test(template);
}

/**
 * Preview how a label template will expand
 * Shows first and last examples for large batches
 * 
 * @param template - The label template
 * @param totalCount - Total number of items
 * @param walletName - Optional wallet name for [wallet] token
 * @returns Array of preview strings
 */
export function previewLabelTemplate(
  template: string, 
  totalCount: number,
  walletName?: string
): string[] {
  if (!template || totalCount <= 0) return [];
  
  const date = new Date();
  const previews: string[] = [];
  
  // Show first example
  previews.push(expandLabelTokens(template, { 
    index: 0, 
    totalCount, 
    walletName, 
    date 
  }));
  
  // Show last example if there are multiple items
  if (totalCount > 1) {
    previews.push(expandLabelTokens(template, { 
      index: totalCount - 1, 
      totalCount, 
      walletName, 
      date 
    }));
  }
  
  return previews;
}

/**
 * Available tokens documentation
 */
export const AVAILABLE_TOKENS = [
  { token: '[#]', description: 'Sequential number (auto-pads: 01, 02... or 001, 002...)' },
  { token: '[date]', description: 'Today\'s date (YYYY-MM-DD)' },
  { token: '[wallet]', description: 'Wallet name from the form below' },
];
