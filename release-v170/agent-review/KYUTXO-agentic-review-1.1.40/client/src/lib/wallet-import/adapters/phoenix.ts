import type { 
  WalletAdapter, 
  DetectionResult, 
  ParseResult, 
  ParsedRecord, 
  FileFormat,
  TransactionDirection 
} from '../types';

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  
  return result;
}

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return { headers, rows };
}

function isOnChainTransaction(context: string): boolean {
  const lowerContext = context.toLowerCase();
  return (
    lowerContext.includes('swap_in') ||
    lowerContext.includes('swap_out') ||
    lowerContext.includes('swap-in') ||
    lowerContext.includes('swap-out') ||
    lowerContext.includes('swapin') ||
    lowerContext.includes('swapout') ||
    lowerContext.includes('on-chain') ||
    lowerContext.includes('onchain') ||
    lowerContext.includes('channel_close') ||
    lowerContext.includes('channel_open') ||
    lowerContext.includes('splice')
  );
}

function determineDirection(row: Record<string, string>): TransactionDirection {
  const amount = parseFloat(row['amount_millisatoshi'] || row['amount_msat'] || row['amount'] || '0');
  const context = (row['context'] || row['type'] || '').toLowerCase();
  
  if (context.includes('swap_out') || context.includes('swapout') || context.includes('sent') || context.includes('outgoing')) {
    return 'outgoing';
  }
  if (context.includes('swap_in') || context.includes('swapin') || context.includes('received') || context.includes('incoming')) {
    return 'incoming';
  }
  
  if (amount < 0) return 'outgoing';
  if (amount > 0) return 'incoming';
  
  return 'unknown';
}

function millisatsToBtc(millisats: number): number {
  return Math.abs(millisats) / 100_000_000_000;
}

function extractTxid(row: Record<string, string>): string | null {
  const txid = row['tx_id'] || row['txid'] || row['transaction_id'] || row['hash'];
  if (txid && txid.length === 64 && /^[a-fA-F0-9]+$/.test(txid)) {
    return txid.toLowerCase();
  }
  return null;
}

export const phoenixAdapter: WalletAdapter = {
  name: 'Phoenix Wallet',
  walletType: 'phoenix',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.includes('phoenix')) {
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'phoenix', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    const phoenixHeaders = ['amount_millisatoshi', 'fees_millisatoshi', 'amount_fiat', 'context'];
    const altPhoenixHeaders = ['amount millisatoshi', 'fees millisatoshi', 'amount fiat'];
    const { headers } = parseCSV(content);
    
    const matchCount = phoenixHeaders.filter(h => headers.includes(h)).length;
    const altMatchCount = altPhoenixHeaders.filter(h => 
      headers.some(header => header.replace(/_/g, ' ') === h)
    ).length;
    
    if (matchCount >= 2 || altMatchCount >= 2) {
      return { walletType: 'phoenix', fileFormat: 'csv', confidence: 0.85 };
    }
    
    if (lowerContent.includes('millisatoshi') && lowerContent.includes('context')) {
      return { walletType: 'phoenix', fileFormat: 'csv', confidence: 0.7 };
    }
    
    if (lowerContent.includes('swap_in') || lowerContent.includes('swap_out')) {
      if (lowerContent.includes('millisatoshi') || lowerContent.includes('msat')) {
        return { walletType: 'phoenix', fileFormat: 'csv', confidence: 0.6 };
      }
    }
    
    return { walletType: 'unknown', fileFormat: 'csv', confidence: 0 };
  },
  
  parse(content: string, fileFormat: FileFormat): ParseResult {
    const records: ParsedRecord[] = [];
    const errors: string[] = [];
    let skippedLightning = 0;
    
    if (fileFormat !== 'csv') {
      errors.push('Phoenix wallet only supports CSV export format');
      return { success: false, records: [], walletType: 'phoenix', fileFormat, errors };
    }
    
    const { headers, rows } = parseCSV(content);
    
    if (rows.length === 0) {
      errors.push('No transaction data found in CSV file');
      return { success: false, records: [], walletType: 'phoenix', fileFormat: 'csv', errors };
    }
    
    for (const row of rows) {
      const context = row['context'] || row['type'] || '';
      
      if (!isOnChainTransaction(context)) {
        skippedLightning++;
        continue;
      }
      
      const txid = extractTxid(row);
      
      if (!txid) {
        continue;
      }
      
      const amountMsat = parseFloat(row['amount_millisatoshi'] || row['amount_msat'] || '0');
      const feesMsat = parseFloat(row['fees_millisatoshi'] || row['fees_msat'] || row['service_fee_msat'] || '0');
      const miningFeeSat = parseFloat(row['mining_fee_sat'] || '0');
      
      const amountBtc = millisatsToBtc(amountMsat);
      const direction = determineDirection(row);
      
      const description = row['description'] || row['desc'] || '';
      const notes = row['notes'] || row['note'] || row['memo'] || '';
      const date = row['date'] || row['timestamp'] || '';
      
      let label = description || `Phoenix ${context.replace(/_/g, ' ')}`;
      if (!label || label.trim() === '') {
        label = direction === 'incoming' ? 'Phoenix Swap In' : 'Phoenix Swap Out';
      }
      
      let combinedNotes = notes;
      if (context) {
        combinedNotes = combinedNotes ? `${combinedNotes}\n[Type: ${context}]` : `[Type: ${context}]`;
      }
      if (feesMsat > 0) {
        const feeBtc = millisatsToBtc(feesMsat);
        combinedNotes = combinedNotes ? `${combinedNotes}\n[Service fee: ${feeBtc.toFixed(8)} BTC]` : `[Service fee: ${feeBtc.toFixed(8)} BTC]`;
      }
      if (miningFeeSat > 0) {
        const miningFeeBtc = miningFeeSat / 100_000_000;
        combinedNotes = combinedNotes ? `${combinedNotes}\n[Mining fee: ${miningFeeBtc.toFixed(8)} BTC]` : `[Mining fee: ${miningFeeBtc.toFixed(8)} BTC]`;
      }
      
      records.push({
        type: 'transaction',
        inputString: txid,
        label,
        notes: combinedNotes || undefined,
        amount: amountBtc,
        date,
        source: 'Phoenix Wallet',
        direction,
        originalData: row,
      });
    }
    
    if (skippedLightning > 0) {
      errors.push(`Skipped ${skippedLightning} Lightning-only transactions (no on-chain TXID)`);
    }
    
    if (records.length === 0 && skippedLightning > 0) {
      errors.push('No on-chain transactions found. This file may contain only Lightning payments.');
    }
    
    return { 
      success: records.length > 0 || skippedLightning > 0, 
      records, 
      walletType: 'phoenix', 
      fileFormat: 'csv', 
      errors 
    };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv'];
  },
};
