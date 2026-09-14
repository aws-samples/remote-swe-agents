import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ja from '../messages/ja.json';

/**
 * Guards the copy of the stale-deployment recovery toasts. The UX decision
 * (maintainer feedback): after an automatic reload + resend, tell the
 * user WHY the page reloaded ("the app was updated") — do NOT announce the
 * resend success, which is self-evident from the message appearing in the
 * timeline. Toasts for non-obvious outcomes (restored-but-not-sent input,
 * dropped settings, missing attachments) stay.
 *
 * The Japanese literals below are i18n locale VALUES asserted against
 * messages/ja.json — they are the product copy itself, not fixtures.
 */
describe('deployment recovery toast copy', () => {
  it('auto-reload path explains the reload reason in both locales', () => {
    expect(en.sessions.reloadedAfterUpdate).toBe('The app was updated, so the page was reloaded.');
    expect(ja.sessions.reloadedAfterUpdate).toBe('アプリが更新されたため、ページを再読み込みしました。');
  });

  it('no longer announces the resend success (old key removed)', () => {
    expect(en.sessions).not.toHaveProperty('autoResentAfterUpdate');
    expect(ja.sessions).not.toHaveProperty('autoResentAfterUpdate');
  });

  it('manual-reload notice (unprotected forms) leads with the app update and asks for a reload', () => {
    expect(en.common.deploymentRecovery.appUpdated).toBe(
      'The app has been updated. Please reload the page to continue.'
    );
    expect(ja.common.deploymentRecovery.appUpdated).toBe(
      'アプリが更新されました。続けるにはページをリロードしてください。'
    );
    expect(en.common.deploymentRecovery.reload).toBe('Reload');
    expect(ja.common.deploymentRecovery.reload).toBe('リロード');
  });

  it('keeps the non-obvious outcome toasts (restore / dropped settings)', () => {
    expect(en.sessions.messageRestoredAfterUpdate).toBeTruthy();
    expect(ja.sessions.messageRestoredAfterUpdate).toBeTruthy();
    expect(en.sessions.settingsNotCarriedOver).toBeTruthy();
    expect(ja.sessions.settingsNotCarriedOver).toBeTruthy();
  });
});
