// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mapping = vi.hoisted(() => ({
  getCategoryMappingItems: vi.fn(),
  getCategoryMappingDraft: vi.fn(),
  saveCategoryMappingDraft: vi.fn(),
  applyCategoryMappingDecision: vi.fn(),
  applyCategoryMappingDraft: vi.fn(),
  getCategoryMappingCheckpoints: vi.fn(),
  checkpointCategoryMappingDecision: vi.fn(),
  clearCategoryMappingCheckpoint: vi.fn(),
}));
vi.mock('@/lib/data/category-mapping-crud', () => mapping);
vi.mock('@/hooks/use-tags', () => ({ useTags: () => ({ tags: [{ id: 1, name: 'Archive' }] }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CategoryMappingSection } from './category-mapping-section';

describe('CategoryMappingSection', () => {
  it('renders every legacy category count and makes a skipped value read-only', async () => {
    mapping.getCategoryMappingItems.mockResolvedValue([
      { name: 'Orphaned import', usageCount: 3 },
      { name: 'Reviewed later', usageCount: 0 },
    ]);
    mapping.getCategoryMappingDraft.mockResolvedValue({
      'Reviewed later': { kind: 'skip' },
    });
    mapping.getCategoryMappingCheckpoints.mockResolvedValue({});
    render(<CategoryMappingSection />);
    await waitFor(() => expect(screen.getByText('Orphaned import')).toBeTruthy());
    expect(screen.getByText('3 records')).toBeTruthy();
    expect(screen.getByText('0 records')).toBeTruthy();
    expect(screen.getByText(/Skipped — remains unchanged and visible read-only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reconsider/ })).toBeTruthy();
  });
});