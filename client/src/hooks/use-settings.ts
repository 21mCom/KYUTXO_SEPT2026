import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Settings, type CustomField } from '@/lib/database';

const defaultTableColumns = {
  tags: true,
  categories: false,
  walletSoftware: false,
  seedName: false,
  privateKeyStatus: false,
  hasAttachments: true,
  source: false,
};

const defaultFieldVisibility = {
  seedName: true,
  walletSoftware: true,
  privateKeyStatus: false,
  counterparty: true,
  source: true,
};

export function useSettings() {
  const settings = useLiveQuery(() => db.settings.get('default'));
  
  return {
    settings: settings || null,
    tableColumns: settings?.tableColumns || defaultTableColumns,
    customFieldColumns: settings?.customFieldColumns || {},
    fieldVisibility: settings?.fieldVisibility || defaultFieldVisibility,
    isLoading: settings === undefined,
  };
}

export function useCustomFields() {
  const customFields = useLiveQuery(() => db.customFields.toArray());
  
  return {
    customFields: customFields || [],
    enabledCustomFields: (customFields || []).filter(f => f.enabled),
    isLoading: customFields === undefined,
  };
}

export async function updateFieldVisibility(fields: Partial<Settings['fieldVisibility']>) {
  const settings = await db.settings.get('default');
  if (settings) {
    await db.settings.update('default', {
      fieldVisibility: {
        ...settings.fieldVisibility,
        ...fields,
      },
    });
  }
}

export async function toggleFieldVisibility(field: keyof Settings['fieldVisibility']) {
  const settings = await db.settings.get('default');
  if (settings && settings.fieldVisibility) {
    await db.settings.update('default', {
      fieldVisibility: {
        ...settings.fieldVisibility,
        [field]: !settings.fieldVisibility[field],
      },
    });
  }
}

export async function updateTableColumns(columns: Partial<Settings['tableColumns']>) {
  const settings = await db.settings.get('default');
  if (settings) {
    await db.settings.update('default', {
      tableColumns: {
        ...settings.tableColumns,
        ...columns,
      },
    });
  }
}

export async function toggleTableColumn(column: keyof Settings['tableColumns']) {
  const settings = await db.settings.get('default');
  if (settings && settings.tableColumns) {
    await db.settings.update('default', {
      tableColumns: {
        ...settings.tableColumns,
        [column]: !settings.tableColumns[column],
      },
    });
  }
}

export async function toggleCustomFieldColumn(slug: string) {
  const settings = await db.settings.get('default');
  if (settings) {
    const currentColumns = settings.customFieldColumns || {};
    await db.settings.update('default', {
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
  const existing = await db.customFields.where('slug').equals(slug).first();
  if (existing) {
    throw new Error(`A field with this name already exists`);
  }
  
  return db.customFields.add({
    name,
    slug,
    enabled: true,
    createdAt: Date.now(),
  });
}

export async function updateCustomField(id: number, updates: Partial<Pick<CustomField, 'name' | 'enabled'>>) {
  const field = await db.customFields.get(id);
  if (!field) return;
  
  const updateData: Partial<CustomField> = {};
  
  if (updates.name !== undefined && updates.name !== field.name) {
    const newSlug = generateSlug(updates.name);
    // Check for duplicate slug (excluding current field)
    const existing = await db.customFields.where('slug').equals(newSlug).first();
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
    await db.customFields.update(id, updateData);
  }
}

export async function toggleCustomField(id: number) {
  const field = await db.customFields.get(id);
  if (field) {
    await db.customFields.update(id, { enabled: !field.enabled });
  }
}

export async function deleteCustomField(id: number) {
  await db.customFields.delete(id);
}
