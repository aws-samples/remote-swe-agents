import { util } from '@aws-appsync/utils';

/**
 * Allow subscription only for the channels that
 * 1. begin with /public
 * 2. begin with /user/<userId>
 * https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespace-handlers.html
 */
export function onSubscribe(ctx) {
  if (ctx.info.channel.path.startsWith(`/event-bus/public`)) {
    return;
  }
  if (ctx.info.channel.path.startsWith(`/event-bus/user`)) {
    if (ctx.info.channel.path.startsWith(`/event-bus/user/${ctx.identity.username}`)) {
      return;
    }
    console.log(`user ${ctx.identity.username} tried connecting to wrong channel: ${ctx.channel}`);
    util.unauthorized();
  }
}
