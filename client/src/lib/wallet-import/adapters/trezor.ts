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
  const type = (row['type'] || row['transaction type'] || '').toLowerCase();
  const amount = parseFloat(row['amount'] || row['value'] || '0');
  
  if (type.includes('sent') || type.includes('send') || type.includes('outgoing')) {
    return 'outgoing';
  }
  if (type.includes('received') || type.includes('receive') || type.includes('incoming')) {
    return 'incoming';
  }
  if (type.includes('self')) {
    return 'self';
  }
  
  if (amount < 0) return 'outgoing';
  if (amount > 0) return 'incoming';
  
  return 'unknown';
}

function extractAddresses(row: Record<string, string>): string[] {
  const addresses: string[] = [];
  
  const addressFields = ['address', 'addresses', 'to', 'from', 'destination', 'source'];
  for (const field of addressFields) {
    const value = row[field];
    if (value) {
      const parts = value.split(/[,;]/).map(a => a.trim()).filter(a => a.length > 20);
      addresses.push(...parts);
    }
  }
  
  return Array.from(new Set(addresses));
}

export const trezorAdapter: WalletAdapter = {
  name: 'Trezor Suite',
  walletType: 'trezor',
  
  detectFormat(content: string, filename: string): DetectionResult {
    const lowerFilename = filename.toLowerCase();
    const lowerContent = content.toLowerCase();
    
    if (lowerFilename.includes('trezor')) {
      if (lowerFilename.endsWith('.json')) {
        return { walletType: 'trezor', fileFormat: 'json', confidence: 0.9 };
      }
      if (lowerFilename.endsWith('.csv')) {
        return { walletType: 'trezor', fileFormat: 'csv', confidence: 0.9 };
      }
    }
    
    if (lowerContent.includes('trezor')) {
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        return { walletType: 'trezor', fileFormat: 'json', confidence: 0.7 };
      }
      return { walletType: 'trezor', fileFormat: 'csv', confidence: 0.7 };
    }
    
    const trezorCSVHeaders = ['transaction id', 'date', 'time', 'type', 'amount', 'fee'];
    const hasHeaders = trezorCSVHeaders.some(h => lowerContent.includes(h));
    
    if (hasHeaders && lowerFilename.endsWith('.csv')) {
      return { walletType: 'trezor', fileFormat: 'csv', confidence: 0.6 };
    }
    
    try {
      const json = JSON.parse(content);
      if (json.transactions || json.addresses || json.trezor) {
        return { walletType: 'trezor', fileFormat: 'json', confidence: 0.5 };
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
        const transactions = data.transactions || data.txs || (Array.isArray(data) ? data : []);
        
        for (const tx of transactions) {
          const txid = tx.txid || tx.hash || tx.id || tx.transaction_id;
          if (!txid) continue;
          
          const amount = parseFloat(tx.amount || tx.value || tx.total || '0');
          const fee = parseFloat(tx.fee || tx.fees || '0');
          
          records.push({
            type: 'transaction',
            inputString: txid,
            label: tx.label || tx.memo || `Trezor Transaction`,
            notes: tx.note || tx.notes || tx.description,
            amount: Math.abs(amount),
            date: tx.date || tx.timestamp || tx.blockTime,
            source: 'Trezor Suite',
            direction: amount < 0 ? 'outgoing' : amount > 0 ? 'incoming' : 'unknown',
            originalData: tx,
          });
          
          const addresses: string[] = [];
          if (tx.addresses) addresses.push(...(Array.isArray(tx.addresses) ? tx.addresses : [tx.addresses]));
          if (tx.inputs) tx.inputs.forEach((i: { address?: string; addresses?: string[] }) => {
            if (i.address) addresses.push(i.address);
            if (i.addresses) addresses.push(...i.addresses);
          });
          if (tx.outputs) tx.outputs.forEach((o: { address?: string; addresses?: string[] }) => {
            if (o.address) addresses.push(o.address);
            if (o.addresses) addresses.push(...o.addresses);
          });
          
          const uniqueAddresses = Array.from(new Set(addresses)).filter(a => a && a.length > 20);
          for (const addr of uniqueAddresses) {
            records.push({
              type: 'address',
              inputString: addr,
              label: `From Trezor TX`,
              source: `Trezor Suite (TX: ${txid.substring(0, 8)}...)`,
              isInputAddress: true,
            });
          }
        }
        
        return { success: true, records, walletType: 'trezor', fileFormat: 'json', errors };
      } catch (e) {
        errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
        return { success: false, records: [], walletType: 'trezor', fileFormat: 'json', errors };
      }
    }
    
    const { rows } = parseCSV(content);
    
    for (const row of rows) {
      const txid = row['transaction id'] || row['txid'] || row['hash'] || row['tx hash'];
      if (!txid) continue;
      
      const amount = parseFloat(row['amount'] || row['value'] || row['total'] || '0');
      const fee = parseFloat(row['fee'] || row['fees'] || '0');
      const direction = determineDirection(row);
      
      let dateStr = row['date'] || row['timestamp'] || row['time'];
      if (row['date'] && row['time']) {
        dateStr = `${row['date']} ${row['time']}`;
      }
      
      records.push({
        type: 'transaction',
        inputString: txid,
        label: row['label'] || row['memo'] || row['description'] || 'Trezor Transaction',
        notes: row['note'] || row['notes'],
        amount: Math.abs(amount),
        date: dateStr,
        source: 'Trezor Suite',
        direction,
        originalData: row,
      });
      
      const addresses = extractAddresses(row);
      for (const addr of addresses) {
        records.push({
          type: 'address',
          inputString: addr,
          label: `From Trezor TX`,
          source: `Trezor Suite (TX: ${txid.substring(0, 8)}...)`,
          isInputAddress: true,
        });
      }
    }
    
    return { success: true, records, walletType: 'trezor', fileFormat: 'csv', errors };
  },
  
  getSupportedFormats(): FileFormat[] {
    return ['csv', 'json'];
  },
};
