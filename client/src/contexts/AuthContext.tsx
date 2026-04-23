import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { 
  generateSalt, 
  hashPassword, 
  verifyPassword,
  bufferToBase64,
  base64ToBuffer,
} from '@/lib/crypto';
import { 
  isVaultInitialized, 
  getVaultSettings, 
  saveVaultSettings,
  isAttachmentPathsMigrated,
  setAttachmentPathsMigrated,
} from '@/lib/vault';
import { migrateAttachmentPaths } from '@/lib/attachments';

interface AuthContextType {
  isInitialized: boolean | null;
  isAuthenticated: boolean;
  setupPassword: (password: string) => Promise<void>;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isInitialized, setIsInitialized] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkVault = async () => {
      try {
        const initialized = await isVaultInitialized();
        setIsInitialized(initialized);
      } catch (error) {
        console.error('Failed to check vault status:', error);
        setIsInitialized(false);
      } finally {
        setIsLoading(false);
      }
    };

    checkVault();
  }, []);

  const runAttachmentPathMigration = useCallback(async () => {
    const alreadyMigrated = await isAttachmentPathsMigrated();
    if (alreadyMigrated) return;

    try {
      const result = await migrateAttachmentPaths();
      if (result.failed === 0 && result.migrated >= 0) {
        await setAttachmentPathsMigrated(true);
      }
    } catch (error) {
      console.error('Attachment path migration failed:', error);
    }
  }, []);

  const setupPassword = useCallback(async (password: string) => {
    setIsLoading(true);
    try {
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);

      await saveVaultSettings(bufferToBase64(salt), hash);

      setIsInitialized(true);
      setIsAuthenticated(true);

      runAttachmentPathMigration();
    } finally {
      setIsLoading(false);
    }
  }, [runAttachmentPathMigration]);

  const login = useCallback(async (password: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const settings = await getVaultSettings();
      if (!settings) {
        return false;
      }

      const salt = base64ToBuffer(settings.salt);
      const isValid = await verifyPassword(password, salt, settings.passwordHash);

      if (isValid) {
        setIsAuthenticated(true);
        runAttachmentPathMigration();
        return true;
      }

      return false;
    } finally {
      setIsLoading(false);
    }
  }, [runAttachmentPathMigration]);

  const logout = useCallback(() => {
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isInitialized,
        isAuthenticated,
        setupPassword,
        login,
        logout,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
