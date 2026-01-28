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

function isOnChainTransaction(row: Record<string, string>): boolean {
  const type = (row['type'] || row['transaction_type'] || '').toLowerCase();
  const description = (row['description'] || row['memo'] || row['note'] || '').toLowerCase();
  const txid = row['txid'] || row['tx_id'] || row['transaction_id'] || row['hash'] || '';
  
  if (txid && txid.length === 64 && /^[a-fA-F0-9]+$/.test(txid)) {
    return true;
  }
  
  if (
    type.includes('deposit') ||
    type.includes('withdrawal') ||
    type.includes('on-chain') ||
    type.includes('onchain') ||
    type.includes('bitcoin') ||
    description.includes('on-chain') ||
    description.includes('onchain') ||
    description.includes('deposit') ||
    description.includes('withdrawal')
  ) {
    return true;
  }
  
  return false;
}

function determineDirection(row: Record<string, string>): TransactionDirection {
  const type = (row['type'] || row['transaction_type'] || '').toLowerCase();
  const amount = parseFloat(row['amount'] || row['sats'] || row['satoshis'] || '0');
  
  if (type.includes('withdrawal') || type.includes('sent') || type.includes('out') || type.includes('payment')) {
    return 'outgoing';
  }
  if (type.includes('deposit') || type.includes('received') || type.includes('in')) {
    return 'incoming';
  }
  
  if (amount < 0) return 'outgoing';
  if (amount > 0) return 'incoming';
  
  return 'unknown';
}

function satsToBtc(sats: number): number {
  return Math.abs(sats) / 100_000_000;
}

function extractTxid(row: Record<string, string>): string | null {
  const txid = row['txid'] || row['tx_id'] || row['transaction_id'] || row['hash'] || row['tx_hash'];
  if (txid && txid.length === 64 && /^[a-fA-F0-9]+$/.test(txid)) {
    return txid.toLowerCase();
  }
  return null;
}

export const walletOfSatoshiAdapter: WalletAdapter = {
  name: 'Wallet of Satoshi',
  walletType: 'wallet-of-satoshi',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.includes('satoshi') || lowerFilename.includes('wos')) {
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'wallet-of-satoshi', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    const wosHeaders = ['date', 'type', 'amount', 'fee', 'description'];
    const { headers } = parseCSV(content);
    
    const matchCount = wosHeaders.filter(h => headers.includes(h)).length;
    
    if (matchCount >= 3 && (lowerContent.includes('sats') || lowerContent.includes('satoshis') || lowerContent.includes('deposit') || lowerContent.includes('withdrawal'))) {
      return { walletType: 'wallet-of-satoshi', fileFormat: 'csv', confidence: 0.7 };
    }
    
    if (lowerContent.includes('wallet of satoshi') || lowerContent.includes('walletofsatoshi')) {
      return { walletType: 'wallet-of-satoshi', fileFormat: 'csv', confidence: 0.8 };
    }
    
    return { walletType: 'unknown', fileFormat: 'csv', confidence: 0 };
  },
  
  parse(content: string, fileFormat: FileFormat): ParseResult {
    const records: ParsedRecord[] = [];
    const errors: string[] = [];
    let skippedLightning = 0;
    
    if (fileFormat !== 'csv') {
      errors.push('Wallet of Satoshi only supports CSV export format');
      return { success: false, records: [], walletType: 'wallet-of-satoshi', fileFormat, errors };
    }
    
    const { headers, rows } = parseCSV(content);
    
    if (rows.length === 0) {
      errors.push('No transaction data found in CSV file');
      return { success: false, records: [], walletType: 'wallet-of-satoshi', fileFormat: 'csv', errors };
    }
    
    for (const row of rows) {
      if (!isOnChainTransaction(row)) {
        skippedLightning++;
        continue;
      }
      
      const txid = extractTxid(row);
      
      if (!txid) {
        continue;
      }
      
      const amountSats = parseFloat(row['amount'] || row['sats'] || row['satoshis'] || '0');
      const feeSats = parseFloat(row['fee'] || row['fees'] || '0');
      
      const amountBtc = satsToBtc(amountSats);
      const direction = determineDirection(row);
      
      const description = row['description'] || row['memo'] || row['note'] || '';
      const type = row['type'] || row['transaction_type'] || '';
      const date = row['date'] || row['timestamp'] || row['time'] || '';
      
      let label = description || `WoS ${type || (direction === 'incoming' ? 'Deposit' : 'Withdrawal')}`;
      if (!label || label.trim() === '') {
        label = direction === 'incoming' ? 'WoS Deposit' : 'WoS Withdrawal';
      }
      
      let notes = '';
      if (type) {
        notes = `[Type: ${type}]`;
      }
      if (feeSats > 0) {
        const feeBtc = satsToBtc(feeSats);
        notes = notes ? `${notes}\n[Fee: ${feeBtc.toFixed(8)} BTC]` : `[Fee: ${feeBtc.toFixed(8)} BTC]`;
      }
      
      records.push({
        type: 'transaction',
        inputString: txid,
        label,
        notes: notes || undefined,
        amount: amountBtc,
        date,
        source: 'Wallet of Satoshi',
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
      walletType: 'wallet-of-satoshi', 
      fileFormat: 'csv', 
      errors 
    };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv'];
  },
};
