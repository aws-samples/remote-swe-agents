'use client';

import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import type { PortMapping } from '@/lib/port-url-transform';

type PortMappingContextValue = {
  mapping: PortMapping | null;
  setMapping: (next: PortMapping | null) => void;
};

const PortMappingContext = createContext<PortMappingContextValue>({
  mapping: null,
  setMapping: () => {},
});

type ProviderProps = {
  initialMapping?: PortMapping | null;
  children: React.ReactNode;
};

export const PortMappingProvider = ({ initialMapping, children }: ProviderProps) => {
  const [mapping, setMappingState] = useState<PortMapping | null>(initialMapping ?? null);

  const setMapping = useCallback((next: PortMapping | null) => {
    setMappingState(next);
  }, []);

  const value = useMemo(() => ({ mapping, setMapping }), [mapping, setMapping]);

  return <PortMappingContext.Provider value={value}>{children}</PortMappingContext.Provider>;
};

/**
 * Returns the current worker session's port mapping (hostname + opened ports)
 * or null when the session has no ports opened via `openPort`.
 */
export const usePortMapping = (): PortMapping | null => useContext(PortMappingContext).mapping;

/**
 * Returns the imperative setter so the top-level client component can update
 * the mapping in response to real-time `portsUpdate` events.
 */
export const usePortMappingSetter = (): ((next: PortMapping | null) => void) =>
  useContext(PortMappingContext).setMapping;
