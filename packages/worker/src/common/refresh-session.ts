import { getSession, setSlackDestination } from '@remote-swe-agents/agent-core/lib';

export const refreshSession = async (workerId: string) => {
  const session = await getSession(workerId);
  if (!session) return;

  if (session.slackChannelId && session.slackThreadTs) {
    setSlackDestination(session.slackChannelId, session.slackThreadTs);
  }
  {
    // For backward compatibility. Will remove this block half year later.
    const SlackChannelId = process.env.SLACK_CHANNEL_ID!;
    const SlackThreadTs = process.env.SLACK_THREAD_TS!;
    if (SlackChannelId && SlackThreadTs) {
      setSlackDestination(SlackChannelId, SlackThreadTs);
    }
  }
};
