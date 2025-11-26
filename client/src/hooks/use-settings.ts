import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Settings } from '@/lib/database';

const defaultTableColumns = {
  tags: true,
  categories: false,
  walletSoftware: false,
  seedName: false,
  privateKeyStatus: false,
  hasAttachments: true,
};

export function useSettings() {
  const settings = useLiveQuery(() => db.settings.get('default'));
  
  return {
    settings: settings || null,
    tableColumns: settings?.tableColumns || defaultTableColumns,
    isLoading: settings === undefined,
  };
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
