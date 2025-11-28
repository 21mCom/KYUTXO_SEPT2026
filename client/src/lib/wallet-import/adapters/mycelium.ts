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
  const type = (row['type'] || row['direction'] || '').toLowerCase();
  const value = parseFloat(row['value'] || row['amount'] || row['btc'] || '0');
  
  if (type.includes('sent') || type.includes('out') || type.includes('payment')) {
    return 'outgoing';
  }
  if (type.includes('received') || type.includes('in') || type.includes('deposit')) {
    return 'incoming';
  }
  
  if (value < 0) return 'outgoing';
  if (value > 0) return 'incoming';
  
  return 'unknown';
}

export const myceliumAdapter: WalletAdapter = {
  name: 'Mycelium',
  walletType: 'mycelium',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.includes('mycelium')) {
      if (lowerFilename.endsWith('.json')) {
        return { walletType: 'mycelium', fileFormat: 'json', confidence: 0.9 };
      }
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'mycelium', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    if (lowerContent.includes('mycelium')) {
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        return { walletType: 'mycelium', fileFormat: 'json', confidence: 0.8 };
      }
      return { walletType: 'mycelium', fileFormat: 'csv', confidence: 0.8 };
    }
    
    const myceliumCSVHeaders = ['account', 'transaction id', 'destination address', 'timestamp', 'value', 'currency', 'transaction label'];
    const { headers } = parseCSV(content);
    const matchCount = myceliumCSVHeaders.filter(h => headers.includes(h)).length;
    
    if (matchCount >= 3) {
      return { walletType: 'mycelium', fileFormat: 'csv', confidence: 0.7 };
    }
    
    const myceliumAltHeaders = ['tx hash', 'confirmations', 'btc', 'fiat'];
    const altMatchCount = myceliumAltHeaders.filter(h => headers.includes(h)).length;
    
    if (altMatchCount >= 2) {
      return { walletType: 'mycelium', fileFormat: 'csv', confidence: 0.6 };
    }
    
    try {
      const json = JSON.parse(content);
      if (json.accounts || json.transactions || json.mycelium) {
        return { walletType: 'mycelium', fileFormat: 'json', confidence: 0.5 };
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
        
        let transactions = data.transactions || [];
        if (data.accounts) {
          for (const account of data.accounts) {
            if (account.transactions) {
              transactions = transactions.concat(account.transactions);
            }
          }
        }
        if (Array.isArray(data)) {
          transactions = data;
        }
        
        for (const tx of transactions) {
          const txid = tx.txid || tx.hash || tx['transaction id'] || tx.id;
          if (!txid) continue;
          
          const value = parseFloat(tx.value || tx.amount || tx.btc || '0');
          
          records.push({
            type: 'transaction',
            inputString: txid,
            label: tx.label || tx['transaction label'] || tx.memo || 'Mycelium Transaction',
            notes: tx.note || tx.notes,
            amount: Math.abs(value),
            date: tx.timestamp || tx.date || tx.time,
            source: 'Mycelium',
            direction: value < 0 ? 'outgoing' : value > 0 ? 'incoming' : 'unknown',
            originalData: tx,
          });
          
          const addresses: string[] = [];
          if (tx['destination address']) addresses.push(tx['destination address']);
          if (tx.address) addresses.push(tx.address);
          if (tx.toAddress) addresses.push(tx.toAddress);
          if (tx.fromAddress) addresses.push(tx.fromAddress);
          
          const uniqueAddresses = Array.from(new Set(addresses)).filter(a => a && a.length > 20);
          for (const addr of uniqueAddresses) {
            records.push({
              type: 'address',
              inputString: addr,
              label: `From Mycelium TX`,
              source: `Mycelium (TX: ${txid.substring(0, 8)}...)`,
            });
          }
        }
        
        return { success: true, records, walletType: 'mycelium', fileFormat: 'json', errors };
      } catch (e) {
        errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return { success: false, records: [], walletType: 'mycelium', fileFormat: 'json', errors };
      }
    }
    
    const { rows } = parseCSV(content);
    
    for (const row of rows) {
      const txid = row['transaction id'] || row['tx hash'] || row['txid'] || row['hash'];
      if (!txid) continue;
      
      const value = parseFloat(row['value'] || row['btc'] || row['amount'] || '0');
      const direction = determineDirection(row);
      
      let dateStr = row['timestamp'] || row['date'] || row['time'];
      
      records.push({
        type: 'transaction',
        inputString: txid,
        label: row['transaction label'] || row['label'] || row['memo'] || 'Mycelium Transaction',
        notes: row['note'] || row['notes'],
        amount: Math.abs(value),
        date: dateStr,
        source: 'Mycelium',
        direction,
        originalData: row,
      });
      
      const destAddress = row['destination address'] || row['address'];
      if (destAddress && destAddress.length > 20) {
        records.push({
          type: 'address',
          inputString: destAddress,
          label: `From Mycelium TX`,
          source: `Mycelium (TX: ${txid.substring(0, 8)}...)`,
        });
      }
    }
    
    return { success: true, records, walletType: 'mycelium', fileFormat: 'csv', errors };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv', 'json'];
  },
};
