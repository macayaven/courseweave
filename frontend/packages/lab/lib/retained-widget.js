"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetainedSessionWidget = void 0;
const widgets_1 = require("@lumino/widgets");
/** Ordinary closing hides the session iframe; actual disposal still tears it down. */
class RetainedSessionWidget extends widgets_1.Widget {
    onCloseRequest() {
        this.hide();
    }
}
exports.RetainedSessionWidget = RetainedSessionWidget;
