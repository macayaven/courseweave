import { Widget } from "@lumino/widgets";
/** Ordinary closing hides the session iframe; actual disposal still tears it down. */
export class RetainedSessionWidget extends Widget {
  protected onCloseRequest(): void {
    this.hide();
  }
}
