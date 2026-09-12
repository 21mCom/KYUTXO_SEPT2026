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

function determineDirection(row: Record<string, string>): TransactionDirection {
  const type = (row['type'] || row['transaction_type'] || row['direction'] || '').toLowerCase();
  const amount = parseFloat(row['amount'] || row['btc'] || row['sats'] || '0');
  
  if (type.includes('receive') || type.includes('incoming') || type.includes('in')) {
    return 'incoming';
  }
  if (type.includes('send') || type.includes('outgoing') || type.includes('out')) {
    return 'outgoing';
  }
  if (type.includes('internal') || type.includes('consolidat')) {
    return 'internal';
  }
  
  if (amount > 0) return 'incoming';
  if (amount < 0) return 'outgoing';
  
  return 'unknown';
}

function parseAmount(row: Record<string, string>): number {
  const amountStr = row['amount'] || row['btc'] || row['value'] || '0';
  const satsStr = row['sats'] || row['satoshis'] || '';
  
  if (satsStr) {
    const sats = parseFloat(satsStr.replace(/,/g, ''));
    return Math.abs(sats) / 100_000_000;
  }
  
  const amount = parseFloat(amountStr.replace(/,/g, '').replace(/btc/i, '').trim());
  return Math.abs(amount);
}

function extractTxid(row: Record<string, string>): string | null {
  const candidates = [
    row['txid'],
    row['tx_id'],
    row['transaction_id'],
    row['hash'],
    row['tx_hash'],
    row['transaction_hash'],
  ];
  
  for (const candidate of candidates) {
    if (candidate && candidate.length === 64 && /^[a-fA-F0-9]+$/.test(candidate)) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

function extractAddress(row: Record<string, string>): string | null {
  const addressFields = [
    row['address'],
    row['recipient'],
    row['destination'],
    row['receiving_address'],
    row['to_address'],
  ];
  
  for (const addr of addressFields) {
    if (addr && (addr.startsWith('bc1') || addr.startsWith('3') || addr.startsWith('1') || 
                 addr.startsWith('tb1') || addr.startsWith('m') || addr.startsWith('n') || addr.startsWith('2'))) {
      return addr;
    }
  }
  return null;
}

export const nunchukAdapter: WalletAdapter = {
  name: 'Nunchuk',
  walletType: 'nunchuk',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.endsWith('.bsms')) {
      return { walletType: 'nunchuk', fileFormat: 'bsms', confidence: 0.95 };
    }
    
    if (lowerFilename.includes('nunchuk') || lowerFilename.includes('nunchuck')) {
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'nunchuk', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    if (lowerContent.includes('nunchuk') || lowerContent.includes('nunchuck')) {
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'nunchuk', fileFormat: 'csv', confidence: 0.8 };
      }
    }
    
    if (lowerContent.startsWith('bsms')) {
      return { walletType: 'nunchuk', fileFormat: 'bsms', confidence: 0.85 };
    }
    
    const nunchukHeaders = ['date', 'txid', 'type', 'amount', 'status'];
    const alternateHeaders = ['transaction_id', 'transaction_type', 'btc', 'confirmations'];
    const { headers } = parseCSV(content);
    
    const matchCount = [...nunchukHeaders, ...alternateHeaders].filter(h => headers.includes(h)).length;
    
    if (matchCount >= 3 && lowerFilename.endsWith('.csv')) {
      return { walletType: 'nunchuk', fileFormat: 'csv', confidence: 0.6 };
    }
    
    return { walletType: 'unknown', fileFormat: 'csv', confidence: 0 };
  },
  
  parse(content: string, fileFormat: FileFormat): ParseResult {
    const records: ParsedRecord[] = [];
    const errors: string[] = [];
    
    if (fileFormat === 'bsms') {
      errors.push('BSMS files should be imported via the Descriptor Import page, not the wallet import system');
      return { success: false, records: [], walletType: 'nunchuk', fileFormat: 'bsms', errors };
    }
    
    if (fileFormat !== 'csv') {
      errors.push('Nunchuk transaction history only supports CSV format');
      return { success: false, records: [], walletType: 'nunchuk', fileFormat, errors };
    }
    
    const { headers, rows } = parseCSV(content);
    
    if (rows.length === 0) {
      errors.push('No transaction data found in CSV file');
      return { success: false, records: [], walletType: 'nunchuk', fileFormat: 'csv', errors };
    }
    
    for (const row of rows) {
      const txid = extractTxid(row);
      const address = extractAddress(row);
      
      if (!txid && !address) {
        continue;
      }
      
      const amount = parseAmount(row);
      const direction = determineDirection(row);
      
      const label = row['label'] || row['note'] || row['memo'] || row['description'] || '';
      const date = row['date'] || row['timestamp'] || row['time'] || '';
      const status = row['status'] || row['confirmations'] || '';
      const fee = row['fee'] || row['fees'] || '';
      
      let notes = '';
      if (status) {
        notes = `[Status: ${status}]`;
      }
      if (fee && parseFloat(fee) > 0) {
        const feeNum = parseFloat(fee.replace(/,/g, ''));
        const feeBtc = fee.toLowerCase().includes('btc') ? feeNum : feeNum / 100_000_000;
        notes = notes ? `${notes}\n[Fee: ${feeBtc.toFixed(8)} BTC]` : `[Fee: ${feeBtc.toFixed(8)} BTC]`;
      }
      
      if (txid) {
        const txLabel = label || `Nunchuk ${direction === 'incoming' ? 'Receive' : direction === 'outgoing' ? 'Send' : 'Transaction'}`;
        
        records.push({
          type: 'transaction',
          inputString: txid,
          label: txLabel,
          notes: notes || undefined,
          amount,
          date,
          source: 'Nunchuk',
          direction,
          originalData: row,
        });
      }
      
      if (address && !records.some(r => r.type === 'address' && r.inputString === address)) {
        records.push({
          type: 'address',
          inputString: address,
          label: label || 'Nunchuk Address',
          notes: txid ? `[Related TXID: ${txid}]` : undefined,
          source: 'Nunchuk',
          originalData: row,
        });
      }
    }
    
    if (records.length === 0) {
      errors.push('No valid transactions or addresses found in the CSV file');
    }
    
    return { 
      success: records.length > 0, 
      records, 
      walletType: 'nunchuk', 
      fileFormat: 'csv', 
      errors 
    };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv', 'bsms'];
  },
};
