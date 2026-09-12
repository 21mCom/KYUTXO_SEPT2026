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
  
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
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
  const amount = parseFloat(row['value'] || row['amount'] || '0');
  const label = (row['label'] || '').toLowerCase();
  
  if (label.includes('sent') || label.includes('payment')) {
    return 'outgoing';
  }
  if (label.includes('received') || label.includes('deposit')) {
    return 'incoming';
  }
  
  if (amount < 0) return 'outgoing';
  if (amount > 0) return 'incoming';
  
  return 'unknown';
}

export const sparrowAdapter: WalletAdapter = {
  name: 'Sparrow Wallet',
  walletType: 'sparrow',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.includes('sparrow')) {
      if (lowerFilename.endsWith('.json')) {
        return { walletType: 'sparrow', fileFormat: 'json', confidence: 0.9 };
      }
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'sparrow', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    if (lowerContent.includes('sparrow')) {
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        return { walletType: 'sparrow', fileFormat: 'json', confidence: 0.7 };
      }
      return { walletType: 'sparrow', fileFormat: 'csv', confidence: 0.7 };
    }
    
    const sparrowCSVHeaders = ['txid', 'date', 'label', 'value', 'balance', 'fee'];
    const { headers } = parseCSV(content);
    const matchCount = sparrowCSVHeaders.filter(h => headers.includes(h)).length;
    
    if (matchCount >= 3) {
      return { walletType: 'sparrow', fileFormat: 'csv', confidence: 0.6 };
    }
    
    try {
      const json = JSON.parse(content);
      if (json.transactions || json.history) {
        return { walletType: 'sparrow', fileFormat: 'json', confidence: 0.5 };
      }
    } catch {
      // Not JSON
    }
    
    return { walletType: 'unknown', fileFormat: 'csv', confidence: 0 };
  },
  
  parse(content: string, fileFormat: FileFormat): ParseResult {
    const records: ParsedRecord[] = [];
    const errors: string[] = [];
    
    if (fileFormat === 'json') {
      try {
        const data = JSON.parse(content);
        
        const transactions = data.transactions || data.history || (Array.isArray(data) ? data : []);
        
        for (const tx of transactions) {
          const txid = tx.txid || tx.hash || tx.id;
          if (!txid) continue;
          
          const amount = parseFloat(tx.value || tx.amount || '0');
          const fee = parseFloat(tx.fee || '0');
          
          records.push({
            type: 'transaction',
            inputString: txid,
            label: tx.label || tx.memo || 'Sparrow Transaction',
            notes: tx.note || tx.notes,
            amount: Math.abs(amount),
            date: tx.date || tx.timestamp || tx.blockDate,
            source: 'Sparrow Wallet',
            direction: amount < 0 ? 'outgoing' : amount > 0 ? 'incoming' : 'unknown',
            originalData: tx,
          });
          
          const addresses: string[] = [];
          if (tx.outputs) {
            for (const output of tx.outputs) {
              if (output.address) addresses.push(output.address);
            }
          }
          if (tx.inputs) {
            for (const input of tx.inputs) {
              if (input.address) addresses.push(input.address);
            }
          }
          
          const uniqueAddresses = Array.from(new Set(addresses)).filter(a => a && a.length > 20);
          for (const addr of uniqueAddresses) {
            records.push({
              type: 'address',
              inputString: addr,
              label: `From Sparrow TX`,
              source: `Sparrow Wallet (TX: ${txid.substring(0, 8)}...)`,
              isInputAddress: true,
            });
          }
        }
        
        const walletAddresses = data.addresses || data.wallet?.addresses || [];
        for (const addr of walletAddresses) {
          const address = typeof addr === 'string' ? addr : addr.address;
          if (address && address.length > 20) {
            records.push({
              type: 'address',
              inputString: address,
              label: addr.label || 'Sparrow Address',
              derivationPath: addr.derivationPath || addr.path,
              source: 'Sparrow Wallet',
              isInputAddress: true,
            });
          }
        }
        
        return { success: true, records, walletType: 'sparrow', fileFormat: 'json', errors };
      } catch (e) {
        errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return { success: false, records: [], walletType: 'sparrow', fileFormat: 'json', errors };
      }
    }
    
    const { rows } = parseCSV(content);
    
    for (const row of rows) {
      const txid = row['txid'] || row['transaction id'] || row['hash'];
      if (!txid) continue;
      
      const amount = parseFloat(row['value'] || row['amount'] || '0');
      const fee = parseFloat(row['fee'] || '0');
      const direction = determineDirection(row);
      
      records.push({
        type: 'transaction',
        inputString: txid,
        label: row['label'] || row['memo'] || 'Sparrow Transaction',
        notes: row['note'] || row['notes'],
        amount: Math.abs(amount),
        date: row['date'] || row['timestamp'],
        source: 'Sparrow Wallet',
        direction,
        originalData: row,
      });
      
      if (row['address'] && row['address'].length > 20) {
        records.push({
          type: 'address',
          inputString: row['address'],
          label: `From Sparrow TX`,
          source: `Sparrow Wallet (TX: ${txid.substring(0, 8)}...)`,
          isInputAddress: true,
        });
      }
    }
    
    return { success: true, records, walletType: 'sparrow', fileFormat: 'csv', errors };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv', 'json'];
  },
};
