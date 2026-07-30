// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { clearSavedPsbts, getAllSavedPsbts } from '@/lib/data/saved-psbts-crud';
import { BuildPsbtDialog } from './BuildPsbtDialog';
import type { UTXO } from '@/pages/UTXOs';
import type { Record as DbRecord } from '@/lib/database';

// jsdom lacks the pointer-capture / scroll APIs Radix Select relies on.
beforeEach(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

// BIP-84 test-vector addresses (valid mainnet P2WPKH).
const ADDR_W0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ADDR_W1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const ADDR_CHANGE0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el';

const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);

function makeUtxos(): UTXO[] {
  return [
    {
      id: `${TXID_A}:0`,
      txid: TXID_A,
      vout: 0,
      address: ADDR_W0,
      amountSats: 100_000,
      blockTime: 1_700_000_000,
      blockHeight: 800_000,
    },
    {
      id: `${TXID_B}:1`,
      txid: TXID_B,
      vout: 1,
      address: ADDR_W0,
      amountSats: 60_000,
      blockTime: 1_700_000_100,
      blockHeight: 800_001,
    },
  ];
}

function renderDialog(props: Partial<Parameters<typeof BuildPsbtDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  render(
    <BuildPsbtDialog
      open={true}
      onOpenChange={onOpenChange}
      utxos={makeUtxos()}
      recordForAddress={() => undefined}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onOpenChange, onSaved };
}

beforeEach(async () => {
  await clearSavedPsbts();
});

afterEach(() => {
  cleanup();
});

describe('BuildPsbtDialog', () => {
  it('shows the selected total and live fee math for a valid send-max build', async () => {
    renderDialog();

    // Selected total appears once metadata prep finishes.
    const total = await screen.findByTestId('text-selected-total');
    expect(total.textContent).toContain('2 UTXOs selected');
    expect(total.textContent).toContain('160,000 sats');

    // Buttons start disabled until a destination is entered.
    expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('input-destination'), {
      target: { value: ADDR_W1 },
    });

    // Live summary: 2 P2WPKH inputs (68 vB each) + 1 P2WPKH output (31) +
    // 10.5 overhead = 177.5 -> 178 vB at the default 5 sats/vB = 890 sats fee.
    await waitFor(() => {
      expect(screen.getByTestId('panel-build-summary')).toBeTruthy();
    });
    expect(screen.getByTestId('text-fee').textContent).toBe('890 sats');
    expect(screen.getByTestId('text-send-amount').textContent).toBe('159,110 sats');
    expect(screen.getByTestId('text-change').textContent).toBe('—');
    expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a validation error for an invalid destination', async () => {
    renderDialog();
    await screen.findByTestId('text-selected-total');
    fireEvent.change(screen.getByTestId('input-destination'), {
      target: { value: 'bc1qnotanaddress' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('text-build-error')).toBeTruthy();
    });
    expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires a change address for a partial send, then shows the change amount', async () => {
    renderDialog();
    await screen.findByTestId('text-selected-total');

    fireEvent.click(screen.getByTestId('switch-send-max'));
    fireEvent.change(screen.getByTestId('input-amount'), { target: { value: '100000' } });
    fireEvent.change(screen.getByTestId('input-destination'), {
      target: { value: ADDR_W1 },
    });

    await waitFor(() => {
      expect(screen.getByTestId('text-build-error').textContent).toMatch(/change address/i);
    });

    fireEvent.change(screen.getByTestId('input-change-address'), {
      target: { value: ADDR_CHANGE0 },
    });

    // 2 inputs + 2 outputs = 208.5 -> 209 vB at 5 sats/vB = 1045 sats fee;
    // change = 160,000 - 100,000 - 1,045 = 58,955.
    await waitFor(() => {
      expect(screen.getByTestId('panel-build-summary')).toBeTruthy();
    });
    expect(screen.getByTestId('text-fee').textContent).toBe('1,045 sats');
    expect(screen.getByTestId('text-change').textContent).toBe('58,955 sats');
    expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(false);
  });

  it('persists the PSBT with decoded components on save', async () => {
    const { onOpenChange, onSaved } = renderDialog();
    await screen.findByTestId('text-selected-total');
    fireEvent.change(screen.getByTestId('input-destination'), {
      target: { value: ADDR_W1 },
    });
    await waitFor(() => {
      expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByTestId('button-save-psbt'));

    await waitFor(async () => {
      const rows = await getAllSavedPsbts();
      expect(rows).toHaveLength(1);
      const saved = rows[0];
      expect(saved.psbtBase64.length).toBeGreaterThan(0);
      expect(saved.destinationAddress).toBe(ADDR_W1);
      expect(saved.inputs).toHaveLength(2);
      expect(saved.inputs[0].amountSats).toBe(100_000);
      expect(saved.sendAmountSats).toBe(159_110);
      expect(saved.feeSats).toBe(890);
      expect(saved.outputs).toEqual([
        { address: ADDR_W1, amountSats: 159_110, isChange: false },
      ]);
    });
    expect(onSaved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a Change wallet selector for multi-wallet selections and fills the suggestion on pick', async () => {
    // Real BIP-84 xpub (test vector) for wallet A; wallet B has a bogus xpub so
    // only A can yield a derivable change suggestion.
    const ZPUB_A =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const ZPUB_B =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYt';
    const recs: { [addr: string]: DbRecord } = {
      [ADDR_W0]: {
        type: 'address', inputString: ADDR_W0, label: '', tags: [], categories: [],
        createdAt: 1, updatedAt: 1, xpub: ZPUB_A, walletName: 'Wallet A',
      } as DbRecord,
      [ADDR_W1]: {
        type: 'address', inputString: ADDR_W1, label: '', tags: [], categories: [],
        createdAt: 1, updatedAt: 1, xpub: ZPUB_B, walletName: 'Wallet B',
      } as DbRecord,
    };
    const utxos = makeUtxos();
    utxos[1].address = ADDR_W1;
    renderDialog({ utxos, recordForAddress: (a) => recs[a] });

    const trigger = await screen.findByTestId('select-change-wallet');
    // No auto-suggestion for a multi-wallet selection.
    expect((screen.getByTestId('input-change-address') as HTMLInputElement).value).toBe('');

    fireEvent.click(trigger);
    const optionA = await screen.findByText('Wallet A');
    fireEvent.click(optionA);

    await waitFor(() => {
      expect((screen.getByTestId('input-change-address') as HTMLInputElement).value).toBe(ADDR_CHANGE0);
    });
  });

  it('rejects a fee rate below the relay minimum', async () => {
    renderDialog();
    await screen.findByTestId('text-selected-total');
    fireEvent.change(screen.getByTestId('input-destination'), {
      target: { value: ADDR_W1 },
    });
    fireEvent.change(screen.getByTestId('input-fee-rate'), { target: { value: '0' } });
    await waitFor(() => {
      expect(screen.getByTestId('text-build-error').textContent).toMatch(/fee rate/i);
    });
    expect((screen.getByTestId('button-save-psbt') as HTMLButtonElement).disabled).toBe(true);
  });
});
