import { useSyncExternalStore } from 'react';

const emptySubscribe = () => () => {};

/**
 * Returns `false` during SSR and the first (hydration) client render, then
 * `true` once mounted on the client.
 *
 * This is the `useSyncExternalStore` form of the classic
 * `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])`
 * hydration guard. It avoids the `react-hooks/set-state-in-effect` violation
 * (and the extra state update) by reading a server snapshot (`false`) vs a
 * client snapshot (`true`) directly. Use it to defer rendering of anything
 * whose output differs between server and client (theme, local timezone,
 * etc.) until after hydration, preventing hydration mismatches (React #418).
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}
