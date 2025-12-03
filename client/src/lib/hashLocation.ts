import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';

// Hash-based location for Electron file:// URLs
// Converts window.location.hash to path-like strings

function getHashPath(): string {
  const hash = window.location.hash;
  // Remove the leading #, default to /
  return hash.replace(/^#/, '') || '/';
}

function hashNavigate(to: string): void {
  window.location.hash = to;
}

// Use hash location for file:// protocol (Electron production)
// Use regular location for http/https (development)
export function useHashLocation(): [string, (to: string) => void] {
  const isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';
  
  const [path, setPath] = useState(() => {
    if (isFileProtocol) {
      return getHashPath();
    }
    return window.location.pathname + window.location.search;
  });

  useEffect(() => {
    if (isFileProtocol) {
      const handleHashChange = () => {
        setPath(getHashPath());
      };
      
      window.addEventListener('hashchange', handleHashChange);
      return () => window.removeEventListener('hashchange', handleHashChange);
    } else {
      const handlePopState = () => {
        setPath(window.location.pathname + window.location.search);
      };
      
      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    }
  }, [isFileProtocol]);

  const navigate = useCallback((to: string) => {
    if (isFileProtocol) {
      hashNavigate(to);
    } else {
      window.history.pushState(null, '', to);
      setPath(to);
    }
  }, [isFileProtocol]);

  return [path, navigate];
}

// For wouter's Router to detect if we're in file:// mode
export function isElectronFileMode(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}
