// @vitest-environment jsdom
// Task: users can pick a saved derivation template and re-derive addresses.
// Covers listing saved templates, applying one, and disabling templates that
// have no stored key.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SavedTemplatesDialog from './SavedTemplatesDialog';
import {
  addDerivationTemplate,
  clearDerivationTemplates,
} from '@/lib/data/derivation-templates-crud';

describe('SavedTemplatesDialog', () => {
  beforeEach(async () => {
    await clearDerivationTemplates({ skipNotification: true });
  });

  it('shows an empty state when no templates are saved', async () => {
    render(
      <SavedTemplatesDialog open onOpenChange={() => {}} onApply={() => {}} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('text-no-templates')).toBeTruthy();
    });
  });

  it('lists saved templates and applies the selected one', async () => {
    const id = await addDerivationTemplate(
      {
        fingerprint: 'deadbeef',
        scriptType: 'P2WPKH',
        derivationPath: "m/84'/0'/0'",
        xpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
        gapLimit: 25,
        network: 'mainnet',
        walletName: 'Cold wallet',
      },
      { skipNotification: true }
    );

    const onApply = vi.fn();
    render(
      <SavedTemplatesDialog open onOpenChange={() => {}} onApply={onApply} />
    );

    await waitFor(() => {
      expect(screen.getByTestId(`template-row-${id}`)).toBeTruthy();
    });
    expect(screen.getByText('Cold wallet')).toBeTruthy();
    expect(screen.getByText('Gap limit 25')).toBeTruthy();

    fireEvent.click(screen.getByTestId(`button-use-template-${id}`));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({
      id,
      gapLimit: 25,
      scriptType: 'P2WPKH',
    });
  });

  it('disables templates that have no stored key', async () => {
    const id = await addDerivationTemplate(
      {
        fingerprint: 'cafebabe',
        scriptType: 'P2PKH',
        derivationPath: "m/44'/0'/0'",
        gapLimit: 20,
        network: 'mainnet',
      },
      { skipNotification: true }
    );

    render(
      <SavedTemplatesDialog open onOpenChange={() => {}} onApply={() => {}} />
    );

    await waitFor(() => {
      const btn = screen.getByTestId(
        `button-use-template-${id}`
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });
});
