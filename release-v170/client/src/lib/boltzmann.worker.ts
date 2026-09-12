import { computeBoltzmann, type BoltzmannInput, type BoltzmannOutput } from './boltzmann';

interface BoltzmannWorkerRequest {
  id: string;
  inputs: BoltzmannInput[];
  outputs: BoltzmannOutput[];
  fee: number;
}

self.onmessage = (e: MessageEvent<BoltzmannWorkerRequest>) => {
  const { id, inputs, outputs, fee } = e.data;
  try {
    const result = computeBoltzmann(inputs, outputs, fee);
    self.postMessage({ id, result, error: null });
  } catch (err) {
    self.postMessage({ id, result: null, error: String(err) });
  }
};
