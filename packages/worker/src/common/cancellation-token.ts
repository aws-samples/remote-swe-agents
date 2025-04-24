export class CancellationToken {
  private _isCancelled: boolean = false;

  public get isCancelled(): boolean {
    return this._isCancelled;
  }

  public cancel(): void {
    this._isCancelled = true;
  }
}
