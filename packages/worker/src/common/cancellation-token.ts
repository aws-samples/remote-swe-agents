export class CancellationToken {
  private _isCancelled: boolean = false;
  private _callback: (() => Promise<any>) | undefined = undefined;
  private _onCancelListeners: Array<() => void> = [];

  public get isCancelled(): boolean {
    return this._isCancelled;
  }

  /**
   * The function that cancelled task must call after it completed stopping its task.
   */
  public async completeCancel() {
    if (this._callback) {
      await this._callback();
    }
  }

  /**
   * Register a listener that fires synchronously when cancel() is called.
   * Used by long-running backends (e.g. kiro-cli) to immediately tear down
   * child processes without waiting for the next streaming chunk.
   * Returns an unsubscribe function.
   *
   * If the token is already cancelled at registration time, the listener
   * fires immediately (synchronously) and a no-op unsubscribe is returned.
   * Errors thrown by the listener in either path are caught and logged so
   * a single misbehaving listener cannot prevent registration nor poison
   * the calling site.
   */
  public onCancel(listener: () => void): () => void {
    if (this._isCancelled) {
      try {
        listener();
      } catch (e) {
        console.error('[CancellationToken] onCancel listener threw (immediate):', e);
      }
      return () => {};
    }
    this._onCancelListeners.push(listener);
    return () => {
      const idx = this._onCancelListeners.indexOf(listener);
      if (idx >= 0) this._onCancelListeners.splice(idx, 1);
    };
  }

  /**
   * @param callback The callback function that is executed when each session is cancelled.
   *
   * Idempotent: subsequent calls after the first do nothing. The first call
   * captures the cancellation callback and drains the listener array; later
   * calls cannot overwrite the callback nor refire listeners.
   */
  public cancel(callback?: () => Promise<any>): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    this._callback = callback;
    const listeners = this._onCancelListeners;
    this._onCancelListeners = [];
    for (const listener of listeners) {
      try {
        listener();
      } catch (e) {
        console.error('[CancellationToken] onCancel listener threw:', e);
      }
    }
  }
}
