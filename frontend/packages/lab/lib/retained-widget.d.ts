import { Widget } from "@lumino/widgets";
/** Ordinary closing hides the session iframe; actual disposal still tears it down. */
export declare class RetainedSessionWidget extends Widget {
    protected onCloseRequest(): void;
}
