import { useState, useCallback } from 'react';
import { useNodeSettings } from './use-node-settings';
import { 
  createProviderFromSettings, 
  parseTransaction,
  type ApiTransaction,
  type ParsedTransaction 
} from '@/lib/blockchain-api';
import { 
  exploreAddress, 
  type AddressExplorationResult,
  type ConnectionNode,
  type TransactionEdge 
} from '@/lib/provenance';
import { db } from '@/lib/database';

export interface FlowNode {
  id: string;
  address: string;
  amount: number;
  timestamp: string;
  hop: number;
  type: "input" | "selected" | "output";
  owner?: string;
  txid?: string;
  label?: string;
  isLabeled: boolean;
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
  txid: string;
}

export interface FlowData {
  nodes: FlowNode[];
  links: FlowLink[];
  stats: {
    inputCount: number;
    outputCount: number;
    totalInputValue: number;
    totalOutputValue: number;
  };
}

export interface UseFlowDataResult {
  flowData: FlowData | null;
  isLoading: boolean;
  error: string | null;
  dataSource: 'local' | 'blockchain' | null;
  fetchFlow: (address: string, hopDepth: number, allowBlockchainFallback?: boolean) => Promise<void>;
}

// Convert satoshis to BTC
const satsToBtc = (sats: number): number => sats / 100000000;

// Format timestamp from unix epoch
const formatTimestamp = (unixTime: number): string => {
  return new Date(unixTime * 1000).toISOString().split('T')[0];
};

export function useFlowData(): UseFlowDataResult {
  const { nodeSettings } = useNodeSettings();
  const [flowData, setFlowData] = useState<FlowData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'local' | 'blockchain' | null>(null);

  // Convert local provenance data to flow format
  // Preserves multi-hop structure by using edge relationships
  const convertLocalDataToFlow = (
    address: string,
    result: AddressExplorationResult
  ): FlowData => {
    const nodes: FlowNode[] = [];
    const links: FlowLink[] = [];
    let nodeIdCounter = 0;

    // Map address to node ID for link resolution
    const addressToNodeId = new Map<string, string>();
    addressToNodeId.set(address, 'selected');

    // Add the selected (center) node
    const centerNode: FlowNode = {
      id: 'selected',
      address: address,
      amount: 0,
      timestamp: new Date().toISOString().split('T')[0],
      hop: 0,
      type: 'selected',
      owner: result.centerNode?.owner,
      label: result.centerNode?.label,
      isLabeled: result.centerNode?.isLabeled || false,
    };

    let centerInputValue = 0;
    let centerOutputValue = 0;

    // First pass: create all nodes and map addresses
    // Sort by hop distance so closer nodes are created first
    const sortedIncoming = [...result.incoming].sort((a, b) => a.hopDistance - b.hopDistance);
    const sortedOutgoing = [...result.outgoing].sort((a, b) => a.hopDistance - b.hopDistance);

    // Create incoming nodes
    sortedIncoming.forEach((conn: ConnectionNode) => {
      const nodeId = `input-${nodeIdCounter++}`;
      addressToNodeId.set(conn.address, nodeId);
      
      const totalValue = conn.edges.reduce((sum: number, e: TransactionEdge) => sum + e.amount, 0);
      if (conn.hopDistance === 1) centerInputValue += totalValue;

      const earliestEdge = conn.edges.reduce((earliest: TransactionEdge, e: TransactionEdge) => 
        e.blockTime < earliest.blockTime ? e : earliest, conn.edges[0]);

      nodes.push({
        id: nodeId,
        address: conn.address,
        amount: satsToBtc(totalValue),
        timestamp: formatTimestamp(earliestEdge.blockTime),
        hop: -conn.hopDistance,
        type: 'input',
        owner: conn.owner,
        txid: earliestEdge.txid,
        label: conn.label,
        isLabeled: conn.isLabeled,
      });
    });

    // Create outgoing nodes
    sortedOutgoing.forEach((conn: ConnectionNode) => {
      const nodeId = `output-${nodeIdCounter++}`;
      addressToNodeId.set(conn.address, nodeId);
      
      const totalValue = conn.edges.reduce((sum: number, e: TransactionEdge) => sum + e.amount, 0);
      if (conn.hopDistance === 1) centerOutputValue += totalValue;

      const latestEdge = conn.edges.reduce((latest: TransactionEdge, e: TransactionEdge) => 
        e.blockTime > latest.blockTime ? e : latest, conn.edges[0]);

      nodes.push({
        id: nodeId,
        address: conn.address,
        amount: satsToBtc(totalValue),
        timestamp: formatTimestamp(latestEdge.blockTime),
        hop: conn.hopDistance,
        type: 'output',
        owner: conn.owner,
        txid: latestEdge.txid,
        label: conn.label,
        isLabeled: conn.isLabeled,
      });
    });

    // Second pass: create links using actual edge relationships
    // For incoming: edge.toAddress is the destination (closer to center)
    sortedIncoming.forEach((conn: ConnectionNode) => {
      const sourceId = addressToNodeId.get(conn.address)!;
      
      conn.edges.forEach((edge: TransactionEdge) => {
        // For incoming flow, fromAddress sends to toAddress
        // The target should be the node closer to center
        const targetAddress = edge.toAddress;
        let targetId = addressToNodeId.get(targetAddress);
        
        // If target not found, it's likely the center address
        if (!targetId && targetAddress === address) {
          targetId = 'selected';
        } else if (!targetId) {
          // Target might be an intermediate hop we have
          targetId = 'selected'; // Fallback to center
        }

        links.push({
          source: sourceId,
          target: targetId,
          value: satsToBtc(edge.amount),
          txid: edge.txid,
        });
      });
    });

    // For outgoing: edge.fromAddress is the source (closer to center)
    sortedOutgoing.forEach((conn: ConnectionNode) => {
      const targetId = addressToNodeId.get(conn.address)!;
      
      conn.edges.forEach((edge: TransactionEdge) => {
        const sourceAddress = edge.fromAddress;
        let sourceId = addressToNodeId.get(sourceAddress);
        
        if (!sourceId && sourceAddress === address) {
          sourceId = 'selected';
        } else if (!sourceId) {
          sourceId = 'selected';
        }

        links.push({
          source: sourceId,
          target: targetId,
          value: satsToBtc(edge.amount),
          txid: edge.txid,
        });
      });
    });

    // Update center node with calculated value
    centerNode.amount = satsToBtc(Math.max(centerInputValue, centerOutputValue));
    nodes.unshift(centerNode);

    return {
      nodes,
      links,
      stats: {
        inputCount: result.incoming.length,
        outputCount: result.outgoing.length,
        totalInputValue: satsToBtc(centerInputValue),
        totalOutputValue: satsToBtc(centerOutputValue),
      },
    };
  };

  // Fetch directly from blockchain API
  const fetchFromBlockchain = async (
    address: string,
    hopDepth: number
  ): Promise<FlowData> => {
    const provider = createProviderFromSettings(nodeSettings);
    const nodes: FlowNode[] = [];
    const links: FlowLink[] = [];
    let nodeIdCounter = 0;

    // Fetch transactions for the address
    const txs: ApiTransaction[] = await provider.getAddressTransactions(address);
    
    if (txs.length === 0) {
      throw new Error('No transactions found for this address');
    }

    // Parse transactions
    const parsedTxs = txs
      .map(tx => parseTransaction(tx))
      .filter((tx): tx is ParsedTransaction => tx !== null)
      .slice(0, 50); // Limit for performance

    let totalInputValue = 0;
    let totalOutputValue = 0;
    const inputAddresses = new Map<string, { amount: number; timestamp: string; txid: string }>();
    const outputAddresses = new Map<string, { amount: number; timestamp: string; txid: string }>();

    parsedTxs.forEach(tx => {
      const timestamp = formatTimestamp(tx.blockTime);
      
      // Check if address is in inputs (spending from this address)
      const isInput = tx.inputs.some(i => i.address === address);
      
      // Check if address is in outputs (receiving to this address)
      const isOutput = tx.outputs.some(o => o.address === address);

      if (isInput) {
        // Address is spending - outputs go to other addresses
        tx.outputs.forEach(output => {
          if (output.address !== address) {
            const existing = outputAddresses.get(output.address);
            const amount = output.amount;
            totalOutputValue += amount;
            
            if (existing) {
              existing.amount += amount;
            } else {
              outputAddresses.set(output.address, { amount, timestamp, txid: tx.txid });
            }
          }
        });
      }

      if (isOutput) {
        // Address is receiving - inputs come from other addresses
        tx.inputs.forEach(input => {
          if (input.address !== address) {
            const existing = inputAddresses.get(input.address);
            const amount = input.amount;
            totalInputValue += amount;
            
            if (existing) {
              existing.amount += amount;
            } else {
              inputAddresses.set(input.address, { amount, timestamp, txid: tx.txid });
            }
          }
        });
      }
    });

    // Build nodes from input addresses
    inputAddresses.forEach((data, addr) => {
      const nodeId = `input-${nodeIdCounter++}`;
      nodes.push({
        id: nodeId,
        address: addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr,
        amount: satsToBtc(data.amount),
        timestamp: data.timestamp,
        hop: -1,
        type: 'input',
        txid: data.txid,
        isLabeled: false,
      });
      links.push({
        source: nodeId,
        target: 'selected',
        value: satsToBtc(data.amount),
        txid: data.txid,
      });
    });

    // Add selected node
    nodes.push({
      id: 'selected',
      address: address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address,
      amount: satsToBtc(Math.max(totalInputValue, totalOutputValue)),
      timestamp: parsedTxs[0]?.blockTime ? formatTimestamp(parsedTxs[0].blockTime) : new Date().toISOString().split('T')[0],
      hop: 0,
      type: 'selected',
      isLabeled: false,
    });

    // Build nodes from output addresses
    outputAddresses.forEach((data, addr) => {
      const nodeId = `output-${nodeIdCounter++}`;
      nodes.push({
        id: nodeId,
        address: addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr,
        amount: satsToBtc(data.amount),
        timestamp: data.timestamp,
        hop: 1,
        type: 'output',
        txid: data.txid,
        isLabeled: false,
      });
      links.push({
        source: 'selected',
        target: nodeId,
        value: satsToBtc(data.amount),
        txid: data.txid,
      });
    });

    return {
      nodes,
      links,
      stats: {
        inputCount: inputAddresses.size,
        outputCount: outputAddresses.size,
        totalInputValue: satsToBtc(totalInputValue),
        totalOutputValue: satsToBtc(totalOutputValue),
      },
    };
  };

  const fetchFlow = useCallback(async (address: string, hopDepth: number, allowBlockchainFallback: boolean = true) => {
    setIsLoading(true);
    setError(null);
    setFlowData(null);
    setDataSource(null);

    try {
      // First try local database using provenance system
      console.log('[FlowData] Checking local provenance data...');
      let localResult: AddressExplorationResult | null = null;
      
      try {
        localResult = await exploreAddress(address, hopDepth);
      } catch (localErr) {
        console.log('[FlowData] Local provenance lookup failed:', localErr);
      }
      
      if (localResult && (localResult.incoming.length > 0 || localResult.outgoing.length > 0)) {
        // We have local data from synced transactions
        console.log('[FlowData] Found local data:', localResult.incoming.length, 'in,', localResult.outgoing.length, 'out');
        const data = convertLocalDataToFlow(address, localResult);
        setFlowData(data);
        setDataSource('local');
        return;
      }

      // No local data found
      if (!allowBlockchainFallback) {
        // User disabled blockchain API - show message instead of error
        console.log('[FlowData] No local data and blockchain fallback disabled');
        setError('No local data found for this address. Enable "Query Blockchain API" to fetch from external sources, or sync this address first using Transaction Sync.');
        return;
      }

      // Fetch from blockchain API
      console.log('[FlowData] No local data found, fetching from blockchain...');
      const blockchainData = await fetchFromBlockchain(address, hopDepth);
      setFlowData(blockchainData);
      setDataSource('blockchain');

    } catch (err) {
      console.error('[FlowData] Error fetching flow data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch flow data');
    } finally {
      setIsLoading(false);
    }
  }, [nodeSettings]);

  return {
    flowData,
    isLoading,
    error,
    dataSource,
    fetchFlow,
  };
}
