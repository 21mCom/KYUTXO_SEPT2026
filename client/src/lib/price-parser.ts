import type { PriceData } from './database';

export type PriceDataSource = 'cryptodatadownload' | 'coingecko' | 'investing' | 'bitget' | 'unknown';

export interface ParseResult {
  success: boolean;
  data: Omit<PriceData, 'id' | 'importedAt'>[];
  source: PriceDataSource;
  errors: string[];
  skipped: number;
}

interface DetectedFormat {
  source: PriceDataSource;
  hasHeader: boolean;
  headerRows: number;
  delimiter: string;
  dateColumn: number;
  dateFormat: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'unix';
  closeColumn: number;
  openColumn?: number;
  highColumn?: number;
  lowColumn?: number;
  volumeColumn?: number;
}

function parseNumber(value: string): number | undefined {
  if (!value || value.trim() === '' || value === '-') return undefined;
  const cleaned = value.replace(/[$,]/g, '').trim();
  if (cleaned.endsWith('K')) {
    return parseFloat(cleaned.slice(0, -1)) * 1000;
  }
  if (cleaned.endsWith('M')) {
    return parseFloat(cleaned.slice(0, -1)) * 1000000;
  }
  if (cleaned.endsWith('B')) {
    return parseFloat(cleaned.slice(0, -1)) * 1000000000;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

function parseDate(value: string, format: DetectedFormat['dateFormat']): string | null {
  const trimmed = value.trim();
  
  if (format === 'YYYY-MM-DD') {
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  
  if (format === 'MM/DD/YYYY') {
    const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
      const month = match[1].padStart(2, '0');
      const day = match[2].padStart(2, '0');
      return `${match[3]}-${month}-${day}`;
    }
  }
  
  if (format === 'DD/MM/YYYY') {
    const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
      const day = match[1].padStart(2, '0');
      const month = match[2].padStart(2, '0');
      return `${match[3]}-${month}-${day}`;
    }
  }
  
  if (format === 'unix') {
    const ts = parseInt(trimmed, 10);
    if (!isNaN(ts)) {
      const date = new Date(ts > 1e12 ? ts : ts * 1000);
      return date.toISOString().split('T')[0];
    }
  }
  
  return null;
}

function detectFormat(lines: string[]): DetectedFormat | null {
  if (lines.length < 2) return null;
  
  const firstLine = lines[0].toLowerCase();
  const secondLine = lines[1]?.toLowerCase() || '';
  
  // CryptoDataDownload format - typically has a note line first
  // Example: "https://www.CryptoDataDownload.com"
  // Then: "unix,date,symbol,open,high,low,close,Volume BTC,Volume USDT"
  if (firstLine.includes('cryptodatadownload')) {
    const headerLine = lines[1];
    const cols = headerLine.split(',').map(c => c.toLowerCase().trim());
    return {
      source: 'cryptodatadownload',
      hasHeader: true,
      headerRows: 2,
      delimiter: ',',
      dateColumn: cols.indexOf('date'),
      dateFormat: 'YYYY-MM-DD',
      closeColumn: cols.indexOf('close'),
      openColumn: cols.indexOf('open'),
      highColumn: cols.indexOf('high'),
      lowColumn: cols.indexOf('low'),
      volumeColumn: cols.findIndex(c => c.includes('volume')),
    };
  }
  
  // CoinGecko format - "snapped_at,price,market_cap,total_volume"
  if (firstLine.includes('snapped_at') || firstLine.includes('price,market_cap')) {
    const cols = firstLine.split(',').map(c => c.toLowerCase().trim());
    return {
      source: 'coingecko',
      hasHeader: true,
      headerRows: 1,
      delimiter: ',',
      dateColumn: cols.indexOf('snapped_at'),
      dateFormat: 'YYYY-MM-DD',
      closeColumn: cols.indexOf('price'),
      volumeColumn: cols.indexOf('total_volume'),
    };
  }
  
  // Investing.com format - "Date,Price,Open,High,Low,Vol.,Change %"
  if (firstLine.includes('date') && (firstLine.includes('change %') || firstLine.includes('vol.'))) {
    const cols = firstLine.split(',').map(c => c.toLowerCase().trim());
    return {
      source: 'investing',
      hasHeader: true,
      headerRows: 1,
      delimiter: ',',
      dateColumn: cols.indexOf('date'),
      dateFormat: 'MM/DD/YYYY',
      closeColumn: cols.indexOf('price'),
      openColumn: cols.indexOf('open'),
      highColumn: cols.indexOf('high'),
      lowColumn: cols.indexOf('low'),
      volumeColumn: cols.findIndex(c => c.includes('vol')),
    };
  }
  
  // Bitget format - similar to investing.com
  if (firstLine.includes('date') && firstLine.includes('price')) {
    const cols = firstLine.split(',').map(c => c.toLowerCase().trim());
    return {
      source: 'bitget',
      hasHeader: true,
      headerRows: 1,
      delimiter: ',',
      dateColumn: cols.indexOf('date'),
      dateFormat: 'YYYY-MM-DD',
      closeColumn: cols.indexOf('price') !== -1 ? cols.indexOf('price') : cols.indexOf('close'),
      openColumn: cols.indexOf('open'),
      highColumn: cols.indexOf('high'),
      lowColumn: cols.indexOf('low'),
      volumeColumn: cols.findIndex(c => c.includes('volume') || c.includes('vol')),
    };
  }
  
  // Generic CSV detection - try to auto-detect columns
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const cols = firstLine.split(delimiter).map(c => c.toLowerCase().trim());
  
  let dateColumn = cols.findIndex(c => c.includes('date') || c.includes('time'));
  let closeColumn = cols.findIndex(c => c === 'close' || c === 'price');
  
  if (dateColumn === -1) dateColumn = 0;
  if (closeColumn === -1) closeColumn = 1;
  
  // Detect date format from first data row
  const dataLine = lines[1];
  const dataCols = dataLine.split(delimiter);
  const dateValue = dataCols[dateColumn]?.trim() || '';
  
  let dateFormat: DetectedFormat['dateFormat'] = 'YYYY-MM-DD';
  if (dateValue.match(/^\d{1,2}\/\d{1,2}\/\d{4}/)) {
    // Check if first part is > 12 (must be DD/MM)
    const firstPart = parseInt(dateValue.split('/')[0], 10);
    dateFormat = firstPart > 12 ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
  } else if (dateValue.match(/^\d{10,13}$/)) {
    dateFormat = 'unix';
  }
  
  return {
    source: 'unknown',
    hasHeader: true,
    headerRows: 1,
    delimiter,
    dateColumn,
    dateFormat,
    closeColumn,
    openColumn: cols.findIndex(c => c === 'open'),
    highColumn: cols.findIndex(c => c === 'high'),
    lowColumn: cols.findIndex(c => c === 'low'),
    volumeColumn: cols.findIndex(c => c.includes('volume') || c.includes('vol')),
  };
}

export function parsePriceCSV(
  csvContent: string,
  asset: string = 'BTC',
  currency: string = 'USD'
): ParseResult {
  const lines = csvContent.split(/\r?\n/).filter(line => line.trim());
  
  if (lines.length === 0) {
    return { success: false, data: [], source: 'unknown', errors: ['Empty file'], skipped: 0 };
  }
  
  const format = detectFormat(lines);
  if (!format) {
    return { success: false, data: [], source: 'unknown', errors: ['Could not detect file format'], skipped: 0 };
  }
  
  const data: Omit<PriceData, 'id' | 'importedAt'>[] = [];
  const errors: string[] = [];
  let skipped = 0;
  
  for (let i = format.headerRows; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = line.split(format.delimiter);
    
    const dateStr = cols[format.dateColumn]?.trim();
    if (!dateStr) {
      skipped++;
      continue;
    }
    
    const date = parseDate(dateStr, format.dateFormat);
    if (!date) {
      errors.push(`Line ${i + 1}: Invalid date format "${dateStr}"`);
      skipped++;
      continue;
    }
    
    const close = parseNumber(cols[format.closeColumn]);
    if (close === undefined) {
      errors.push(`Line ${i + 1}: Invalid close price`);
      skipped++;
      continue;
    }
    
    const pricePoint: Omit<PriceData, 'id' | 'importedAt'> = {
      date,
      currency,
      asset,
      close,
      source: format.source,
    };
    
    if (format.openColumn !== undefined && format.openColumn >= 0) {
      pricePoint.open = parseNumber(cols[format.openColumn]);
    }
    if (format.highColumn !== undefined && format.highColumn >= 0) {
      pricePoint.high = parseNumber(cols[format.highColumn]);
    }
    if (format.lowColumn !== undefined && format.lowColumn >= 0) {
      pricePoint.low = parseNumber(cols[format.lowColumn]);
    }
    if (format.volumeColumn !== undefined && format.volumeColumn >= 0) {
      pricePoint.volume = parseNumber(cols[format.volumeColumn]);
    }
    
    data.push(pricePoint);
  }
  
  // Sort by date ascending
  data.sort((a, b) => a.date.localeCompare(b.date));
  
  return {
    success: data.length > 0,
    data,
    source: format.source,
    errors: errors.slice(0, 10), // Limit to first 10 errors
    skipped,
  };
}

export function getSourceDisplayName(source: PriceDataSource): string {
  switch (source) {
    case 'cryptodatadownload': return 'CryptoDataDownload';
    case 'coingecko': return 'CoinGecko';
    case 'investing': return 'Investing.com';
    case 'bitget': return 'Bitget';
    default: return 'Unknown';
  }
}

export const DATA_SOURCES = [
  {
    name: 'CryptoDataDownload',
    url: 'https://www.cryptodatadownload.com/data/',
    description: 'Free daily/hourly OHLCV data from 20+ exchanges. No registration required.',
    format: 'CSV with header row',
  },
  {
    name: 'CoinGecko',
    url: 'https://www.coingecko.com/en/coins/bitcoin/historical_data',
    description: 'Historical prices, market cap, and volume. Quick CSV export available.',
    format: 'CSV with date, price, market_cap, volume',
  },
  {
    name: 'Investing.com',
    url: 'https://www.investing.com/crypto/bitcoin/historical-data',
    description: 'Historical data back to 2010. Download as CSV from the page.',
    format: 'CSV with Date, Price, Open, High, Low, Vol.',
  },
  {
    name: 'Bitget',
    url: 'https://www.bitget.com/price/bitcoin/historical-data',
    description: 'Free historical data with daily/weekly/monthly intervals.',
    format: 'CSV download',
  },
];
