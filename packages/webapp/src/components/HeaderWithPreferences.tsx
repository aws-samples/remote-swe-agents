import { getPreferences } from '@remote-swe-agents/agent-core/lib';
import Header from './Header';

export default async function HeaderWithPreferences() {
  const preferences = await getPreferences();
  return <Header hasCustomIcon={!!preferences.defaultAgentIconKey} />;
}
