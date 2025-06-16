export class CancellationToken {
  private _isCancelled: boolean = false;
  private _callback: (() => Promise<any>) | undefined = undefined;

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
   * @param callback The callback function that is executed when each session is cancelled.
   */
  public cancel(callback?: () => Promise<any>): void {
    this._isCancelled = true;
    this._callback = callback;
  }
}
