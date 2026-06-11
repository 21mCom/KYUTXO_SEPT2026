import { useLiveQuery } from 'dexie-react-hooks';
import { type Settings, type CustomField } from '@/lib/database';
import {
  getSettings as getStoredSettings,
  updateSettings as updateStoredSettings,
} from '@/lib/data/settings-crud';
import {
  addCustomField as addStoredCustomField,
  updateCustomField as updateStoredCustomField,
  deleteCustomField as deleteStoredCustomField,
  getCustomField as getStoredCustomField,
  getCustomFieldBySlug,
  getAllCustomFields,
} from '@/lib/data/custom-fields-crud';

const defaultTableColumns = {
  tags: true,
  categories: false,
  walletSoftware: false,
  seedName: false,
  privateKeyStatus: false,
  hasAttachments: true,
  owner: false,
  walletName: false,
  source: false,
  firstSeen: false,
  balance: false,
  lastTxDate: false,
  txCount: false,
};

const defaultFieldVisibility = {
  seedName: true,
  walletSoftware: true,
  privateKeyStatus: false,
  owner: true,
  walletName: true,
  source: true,
};

import { DEFAULT_CANCEL_CONFIRM_THRESHOLD } from '@/lib/buildProgress';

export function useSettings() {
  const settings = useLiveQuery(() => getStoredSettings('default'));
  
  return {
    settings: settings || null,
    tableColumns: settings?.tableColumns || defaultTableColumns,
    customFieldColumns: settings?.customFieldColumns || {},
    fieldVisibility: settings?.fieldVisibility || defaultFieldVisibility,
    cancelConfirmThreshold: settings?.cancelConfirmThreshold ?? DEFAULT_CANCEL_CONFIRM_THRESHOLD,
    isLoading: settings === undefined,
  };
}

export function useCustomFields() {
  const customFields = useLiveQuery(() => getAllCustomFields());
  
  return {
    customFields: customFields || [],
    enabledCustomFields: (customFields || []).filter(f => f.enabled),
    isLoading: customFields === undefined,
  };
}

export async function updateFieldVisibility(fields: Partial<Settings['fieldVisibility']>) {
  const settings = await getStoredSettings('default');
  if (settings) {
    await updateStoredSettings('default', {
      fieldVisibility: {
        ...settings.fieldVisibility,
        ...fields,
      },
    });
  }
}

export async function toggleFieldVisibility(field: keyof Settings['fieldVisibility']) {
  const settings = await getStoredSettings('default');
  if (settings && settings.fieldVisibility) {
    await updateStoredSettings('default', {
      fieldVisibility: {
        ...settings.fieldVisibility,
        [field]: !settings.fieldVisibility[field],
      },
    });
  }
}

export async function updateTableColumns(columns: Partial<Settings['tableColumns']>) {
  const settings = await getStoredSettings('default');
  if (settings) {
    await updateStoredSettings('default', {
      tableColumns: {
        ...settings.tableColumns,
        ...columns,
      },
    });
  }
}

export async function toggleTableColumn(column: keyof Settings['tableColumns']) {
  const settings = await getStoredSettings('default');
  if (settings && settings.tableColumns) {
    await updateStoredSettings('default', {
      tableColumns: {
        ...settings.tableColumns,
        [column]: !settings.tableColumns[column],
      },
    });
  }
}

export async function updateCancelConfirmThreshold(value: number) {
  const settings = await getStoredSettings('default');
  if (settings) {
    await updateStoredSettings('default', {
      cancelConfirmThreshold: value,
    });
  }
}

export async function toggleCustomFieldColumn(slug: string) {
  const settings = await getStoredSettings('default');
  if (settings) {
    const currentColumns = settings.customFieldColumns || {};
    await updateStoredSettings('default', {
      customFieldColumns: {
        ...currentColumns,
        [slug]: !currentColumns[slug],
      },
    });
  }
}

// Generate slug from field name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Custom field CRUD operations
export async function addCustomField(name: string): Promise<number | undefined> {
  const slug = generateSlug(name);
  
  // Check for duplicate slug
  const existing = await getCustomFieldBySlug(slug);
  if (existing) {
    throw new Error(`A field with this name already exists`);
  }
  
  return addStoredCustomField({
    name,
    slug,
    enabled: true,
  });
}

export async function updateCustomField(id: number, updates: Partial<Pick<CustomField, 'name' | 'enabled'>>) {
  const field = await getStoredCustomField(id);
  if (!field) return;
  
  const updateData: Partial<CustomField> = {};
  
  if (updates.name !== undefined && updates.name !== field.name) {
    const newSlug = generateSlug(updates.name);
    // Check for duplicate slug (excluding current field)
    const existing = await getCustomFieldBySlug(newSlug);
    if (existing && existing.id !== id) {
      throw new Error(`A field with this name already exists`);
    }
    updateData.name = updates.name;
    updateData.slug = newSlug;
  }
  
  if (updates.enabled !== undefined) {
    updateData.enabled = updates.enabled;
  }
  
  if (Object.keys(updateData).length > 0) {
    await updateStoredCustomField(id, updateData);
  }
}

export async function toggleCustomField(id: number) {
  const field = await getStoredCustomField(id);
  if (field) {
    await updateStoredCustomField(id, { enabled: !field.enabled });
  }
}

export async function deleteCustomField(id: number) {
  await deleteStoredCustomField(id);
}
